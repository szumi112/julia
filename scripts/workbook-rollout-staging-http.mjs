import {
  WORKBOOK_MATERIALIZER_VERSION,
  WORKBOOK_PARSER_VERSION,
} from '../src/workbook-import.js'

const failed = () => { throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const MAX_JSON_BYTES = 4 * 1024 * 1024
const CSRF_REFRESH_SKEW_MS = 60_000

export class WorkbookRolloutHttpError extends Error {
  constructor(code, status, details = null) {
    super('WORKBOOK_ROLLOUT_STAGING_FAILED')
    this.code = code
    this.status = status
    this.details = details
    this.definitivePrewrite = (
      (status === 400 && code === 'WORKBOOK_PREVIEW_TOKEN_INVALID')
      || (status === 409 && code === 'VERSION_CONFLICT')
    )
  }
}

export function cacheControlDirectives(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) failed()
  const directives = value.split(',').map((part) => part.trim().toLowerCase())
  if (directives.some((part) => !/^[a-z][a-z0-9-]*(?:=(?:"[^"]*"|[^\s,]+))?$/.test(part))) failed()
  return Object.freeze(directives)
}

export function exactNoStore(headers, { requirePrivate = false } = {}) {
  if (!plain(headers)) return false
  try {
    const directives = cacheControlDirectives(headers['cache-control'])
    const expected = requirePrivate ? ['no-store', 'private'] : ['no-store']
    return directives.length === expected.length
      && new Set(directives).size === directives.length
      && expected.every((directive) => directives.includes(directive))
  } catch { return false }
}

function exactResponseUrl(response, expectedUrl) {
  if (typeof response?.url !== 'function' || response.url() !== expectedUrl) failed()
}

async function json(response, expectedUrl) {
  exactResponseUrl(response, expectedUrl)
  const headers = typeof response.headers === 'function' ? response.headers() : null
  const mediaType = String(headers?.['content-type'] ?? '').toLowerCase()
  if (!exactNoStore(headers)
    || !['application/json', 'application/json; charset=utf-8'].includes(mediaType)
    || String(headers['x-content-type-options'] ?? '').toLowerCase() !== 'nosniff') failed()
  let bytes
  let payload
  try {
    bytes = await response.body()
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_JSON_BYTES) failed()
    payload = JSON.parse(bytes.toString('utf8'))
    if (!response || typeof response.ok !== 'function') failed()
    if (!response.ok()) {
      if (!exact(payload, ['error']) || !plain(payload.error)) failed()
      const errorKeys = [
        'code', 'correlationId',
        ...(Object.hasOwn(payload.error, 'details') ? ['details'] : []),
      ]
      if (!exact(payload.error, errorKeys)
        || typeof payload.error.code !== 'string'
        || !/^[A-Z][A-Z0-9_]{1,80}$/.test(payload.error.code)
        || typeof payload.error.correlationId !== 'string'
        || payload.error.correlationId.length < 1 || payload.error.correlationId.length > 128
        || /[\p{Cc}\p{Cf}]/u.test(payload.error.correlationId)) failed()
      let details = null
      if (payload.error.code === 'VERSION_CONFLICT') {
        if (!exact(payload.error.details, ['currentVersion'])
          || !Number.isSafeInteger(payload.error.details.currentVersion)
          || payload.error.details.currentVersion < 0) failed()
        details = { currentVersion: payload.error.details.currentVersion }
      } else if (Object.hasOwn(payload.error, 'details')) failed()
      throw new WorkbookRolloutHttpError(
        payload.error.code, response.status(), details,
      )
    }
    if (!exact(payload, ['data']) || !plain(payload.data)) failed()
    return payload.data
  } catch (error) {
    if (error instanceof WorkbookRolloutHttpError) throw error
    failed()
  } finally { bytes?.fill(0) }
}

export async function readStagingSession(response, expectedRole = 'owner', expectedUrl = response?.url?.()) {
  const data = await json(response, expectedUrl)
  const keys = [
    'actor', 'authorityRevision', 'capabilities', 'csrfToken', 'csrfExpiresAt',
    'environment', 'dataMode',
  ]
  const actorKeys = [
    'id', 'displayName', 'professionalTitle', 'role', 'specialistId', 'version',
  ]
  if (!exact(data, keys) || !exact(data.actor, actorKeys)
    || !Array.isArray(data.capabilities) || data.capabilities.length > 100
    || data.capabilities.some((capability) => typeof capability !== 'string'
      || capability.length < 1 || capability.length > 120)
    || !['owner', 'coordinator', 'specialist'].includes(expectedRole)
    || data.environment !== 'staging' || data.dataMode !== 'fictional'
    || data.actor.role !== expectedRole
    || (expectedRole === 'owner' && !data.capabilities.includes('finance.import'))
    || typeof data.csrfToken !== 'string' || data.csrfToken.length < 1
    || data.csrfToken.length > 4096 || typeof data.csrfExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(data.csrfExpiresAt))) failed()
  return data
}

const IMPORT_KEYS = Object.freeze([
  'id', 'artifactId', 'status', 'acceptedRecords', 'quarantinedRecords',
  'createdByStaffId', 'version', 'createdAt', 'updatedAt', 'completedAt',
])
const JOB_KEYS = Object.freeze([
  'id', 'phase', 'status', 'cursor', 'totalRecords', 'processedRecords',
  'version', 'updatedAt', 'completedAt',
])

function state(data, expectedActorId, create = false) {
  const dataKeys = create ? ['import'] : [
    'import', 'job', 'evidence',
    ...(Object.hasOwn(data ?? {}, 'reconciliation') ? ['reconciliation'] : []),
  ]
  if (!exact(data, dataKeys) || !exact(data.import, IMPORT_KEYS)
    || data.import.createdByStaffId !== expectedActorId
    || (!create && (!exact(data.job, JOB_KEYS)
      || !exact(data.evidence, ['createdRecords', 'voidedRecords', 'converged'])))) failed()
  const evidence = create ? {} : data.evidence
  return {
    importId: data.import.id,
    artifactId: data.import.artifactId,
    status: data.import.status,
    version: data.import.version,
    createdRecords: evidence.createdRecords ?? 0,
    voidedRecords: evidence.voidedRecords ?? 0,
    converged: evidence.converged ?? false,
  }
}

export function createStagingWorkbookApi({
  requestContext, origin, csrfToken, csrfExpiresAt = null, refreshCsrf = null,
  expectedActorId, expectedAuthorityRevision, now = () => Date.now(),
}) {
  let parsedOrigin
  try { parsedOrigin = new URL(origin) } catch { failed() }
  if (!requestContext || typeof requestContext.get !== 'function'
    || typeof requestContext.post !== 'function' || typeof csrfToken !== 'string'
    || csrfToken.length < 1 || csrfToken.length > 4096
    || typeof origin !== 'string' || parsedOrigin.origin !== origin
    || !(csrfExpiresAt === null || (typeof csrfExpiresAt === 'string'
      && Number.isFinite(Date.parse(csrfExpiresAt))))
    || !(refreshCsrf === null || typeof refreshCsrf === 'function')
    || typeof expectedActorId !== 'string'
    || !/^stf_[A-Za-z0-9_-]{1,120}$/.test(expectedActorId)
    || !Number.isSafeInteger(expectedAuthorityRevision) || expectedAuthorityRevision < 1
    || typeof now !== 'function') failed()
  let csrf = { token: csrfToken, expiresAt: csrfExpiresAt }
  const url = (path) => new URL(path, `${origin}/`).href
  const replaceCsrf = (value) => {
    if (!plain(value) || !plain(value.actor) || value.actor.id !== expectedActorId
      || value.authorityRevision !== expectedAuthorityRevision
      || typeof value.csrfToken !== 'string'
      || value.csrfToken.length < 1 || value.csrfToken.length > 4096
      || typeof value.csrfExpiresAt !== 'string'
      || !Number.isFinite(Date.parse(value.csrfExpiresAt))) failed()
    csrf = { token: value.csrfToken, expiresAt: value.csrfExpiresAt }
  }
  const refresh = async () => {
    if (refreshCsrf === null) failed()
    replaceCsrf(await refreshCsrf())
  }
  const proactiveRefresh = async () => {
    const observedNow = now()
    if (!Number.isSafeInteger(observedNow) || observedNow < 0) failed()
    if (csrf.expiresAt !== null
      && Date.parse(csrf.expiresAt) <= observedNow + CSRF_REFRESH_SKEW_MS) {
      await refresh()
    }
  }
  const mutationHeaders = (idempotencyKey) => ({
    Accept: 'application/json',
    'X-CSRF-Token': csrf.token,
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  })
  const workbookPart = (workbook) => {
    if (!plain(workbook) || !Buffer.isBuffer(workbook.buffer) || workbook.buffer.length < 1
      || workbook.buffer.length > 5 * 1024 * 1024) failed()
    return {
      name: 'approved-workbook.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: workbook.buffer,
    }
  }
  const isCsrfFailure = async (response, expectedUrl) => {
    exactResponseUrl(response, expectedUrl)
    if (response.status() !== 403) return false
    const headers = response.headers()
    if (!exactNoStore(headers)
      || !['application/json', 'application/json; charset=utf-8']
        .includes(String(headers['content-type'] ?? '').toLowerCase())
      || String(headers['x-content-type-options'] ?? '').toLowerCase() !== 'nosniff') failed()
    let bytes
    try {
      bytes = await response.body()
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_JSON_BYTES) failed()
      const payload = JSON.parse(bytes.toString('utf8'))
      return exact(payload, ['error']) && plain(payload.error)
        && ['CSRF_INVALID', 'CSRF_EXPIRED'].includes(payload.error.code)
    } catch { failed() } finally { bytes?.fill(0) }
  }
  const postMutation = async (path, buildOptions) => {
    await proactiveRefresh()
    const expectedUrl = url(path)
    let response = await requestContext.post(path, { ...buildOptions(), maxRedirects: 0 })
    if (await isCsrfFailure(response, expectedUrl)) {
      await refresh()
      response = await requestContext.post(path, { ...buildOptions(), maxRedirects: 0 })
    }
    return { response, expectedUrl }
  }
  const getJson = async (path) => json(await requestContext.get(path, { maxRedirects: 0 }), url(path))
  return Object.freeze({
    async operatorEvidence() {
      return getJson('/api/v1/workbooks/operator-evidence')
    },
    async preview(workbook) {
      const request = await postMutation('/api/v1/workbooks/preview', () => ({
        headers: mutationHeaders(), multipart: { workbook: workbookPart(workbook) },
      }))
      const data = await json(request.response, request.expectedUrl)
      const previewKeys = [
        'fingerprint', 'parserVersion', 'materializerVersion', 'planDigest',
        'previewToken', 'counts', 'warnings', 'reconciliation', 'proposedMappings',
        'conflicts', 'quarantine', 'workbookKind',
        ...(Object.hasOwn(data, 'panelChanges') ? ['panelChanges'] : []),
      ]
      if (!exact(data, previewKeys) || !plain(data.counts) || !plain(data.reconciliation)
        || data.parserVersion !== WORKBOOK_PARSER_VERSION
        || data.materializerVersion !== WORKBOOK_MATERIALIZER_VERSION
        || typeof data.planDigest !== 'string'
        || !/^v1_[A-Za-z0-9_-]{43}$/.test(data.planDigest)
        || data.workbookKind !== 'legacy'
        || !Array.isArray(data.conflicts) || data.conflicts.length > 100
        || !Array.isArray(data.warnings) || data.warnings.length > 100
        || !Array.isArray(data.proposedMappings) || data.proposedMappings.length > 100
        || !Array.isArray(data.quarantine) || data.quarantine.length > 100
        || data.conflicts.some((conflict) => !plain(conflict)
          || conflict.code !== 'SPECIALIST_MAPPING_REQUIRED'
          || typeof conflict.id !== 'string' || !/^wmc_[A-Za-z0-9_-]{1,120}$/.test(conflict.id))) failed()
      return {
        fingerprint: data.fingerprint,
        parserVersion: data.parserVersion,
        materializerVersion: data.materializerVersion,
        planDigest: data.planDigest,
        previewToken: data.previewToken,
        conflictIds: data.conflicts.map((conflict) => conflict?.id),
        workbookKind: data.workbookKind,
      }
    },
    async commit({ workbook, previewToken, resolutions, idempotencyKey }) {
      const request = await postMutation('/api/v1/workbooks/imports', () => ({
        headers: mutationHeaders(idempotencyKey),
        multipart: {
          previewToken,
          resolutions: JSON.stringify(resolutions),
          workbook: workbookPart(workbook),
        },
      }))
      const data = await json(request.response, request.expectedUrl)
      return state(data, expectedActorId, true)
    },
    async status(importId) {
      return state(await getJson(`/api/v1/workbooks/imports/${importId}`), expectedActorId)
    },
    async continue({ importId, expectedVersion, idempotencyKey }) {
      const path = `/api/v1/workbooks/imports/${importId}/continue`
      const request = await postMutation(path, () => ({
          headers: mutationHeaders(idempotencyKey),
          multipart: { expectedVersion: String(expectedVersion) },
      }))
      const data = await json(request.response, request.expectedUrl)
      return state(data, expectedActorId)
    },
    async artifactVerification(importId) {
      return getJson(`/api/v1/workbooks/imports/${importId}/artifact-verification`)
    },
    async reconciliation(importId) {
      return getJson(`/api/v1/workbooks/imports/${importId}/reconciliation`)
    },
    async refreshAuthority() {
      await refresh()
    },
    async exportWorkbook({ format, idempotencyKey }) {
      if (!['panel-v2', 'compatible'].includes(format) || !idempotencyKey) failed()
      const path = '/api/v1/workbooks/exports'
      const request = await postMutation(path, () => ({
        headers: {
          ...mutationHeaders(idempotencyKey),
          Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Type': 'application/json',
        },
        data: { format },
      }))
      return request.response
    },
  })
}
