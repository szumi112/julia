import {
  WORKBOOK_MATERIALIZER_VERSION,
  WORKBOOK_PARSER_VERSION,
} from '../src/workbook-import.js'

const failed = () => { throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const identifier = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,120}$`).test(value)
const MAX_JSON_BYTES = 4 * 1024 * 1024
const CSRF_REFRESH_SKEW_MS = 60_000
const APPROVED_WORKBOOK_FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'

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
const HISTORICAL_JOB_KEYS = Object.freeze([
  'id', 'importId', 'status', 'afterSourceRecordId', 'totalRecords',
  'processedRecords', 'projectedRecords', 'conflictCount', 'version', 'updatedAt',
  'completedAt',
])
const ACTIVITY_JOB_KEYS = Object.freeze([
  'id', 'importId', 'status', 'afterSourceRecordId', 'totalRecords',
  'processedRecords', 'projectedRecords', 'version', 'updatedAt', 'completedAt',
])
const REVIEW_BINDING_KEYS = Object.freeze([
  'environment', 'centreId', 'fingerprint', 'artifactId', 'importId', 'creatorId',
  'planDigest',
])

function projectionJob(value, kind) {
  const keys = kind === 'historical' ? HISTORICAL_JOB_KEYS : ACTIVITY_JOB_KEYS
  const statuses = kind === 'historical'
    ? ['ready', 'running', 'conflicts', 'complete', 'failed']
    : ['ready', 'running', 'complete', 'failed']
  if (!exact(value, keys)
    || !identifier(value.id, kind === 'historical' ? 'hpj' : 'apj')
    || !identifier(value.importId, 'wbi') || !statuses.includes(value.status)
    || !(value.afterSourceRecordId === null || identifier(value.afterSourceRecordId, 'wbs'))
    || ![value.totalRecords, value.processedRecords, value.projectedRecords]
      .every((count) => Number.isSafeInteger(count) && count >= 0)
    || value.processedRecords > value.totalRecords
    || (kind === 'historical'
      && (!Number.isSafeInteger(value.conflictCount) || value.conflictCount < 0))
    || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || !(value.completedAt === null || (typeof value.completedAt === 'string'
      && Number.isFinite(Date.parse(value.completedAt))))
    || (value.status === 'complete') !== (value.completedAt !== null)) failed()
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])))
}

function reviewContext(value) {
  const keys = [
    'counterparty', 'serviceLabel', 'proposedClassification', 'proposedServiceId',
    'nearSubjectIds',
  ]
  if (!exact(value, keys)
    || !safeReviewText(value.counterparty, 160) || !safeReviewText(value.serviceLabel, 240)
    || !['person', 'counterparty', 'review'].includes(value.proposedClassification)
    || !(value.proposedServiceId === null || (typeof value.proposedServiceId === 'string'
      && value.proposedServiceId.length >= 1 && value.proposedServiceId.length <= 80))
    || !Array.isArray(value.nearSubjectIds) || value.nearSubjectIds.length > 100
    || value.nearSubjectIds.some((id) => !subjectIdentifier(id))) {
    failed()
  }
  return Object.freeze({
    counterparty: value.counterparty,
    serviceLabel: value.serviceLabel,
    proposedClassification: value.proposedClassification,
    proposedServiceId: value.proposedServiceId,
    nearSubjectIds: Object.freeze([...value.nearSubjectIds]),
  })
}

function safeReviewText(value, maximum) {
  if (typeof value !== 'string' || value !== value.normalize('NFC')
    || value !== value.trim() || !value.isWellFormed()
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false
  const bytes = new TextEncoder().encode(value)
  const valid = bytes.byteLength >= 1 && bytes.byteLength <= maximum
  bytes.fill(0)
  return valid
}

const subjectIdentifier = (value) => typeof value === 'string'
  && (identifier(value, 'hcl') || identifier(value, 'hcp'))

function historicalProjectionData(data) {
  if (!exact(data, ['projection', 'conflicts'])
    || !(data.projection === null || plain(data.projection))
    || !Array.isArray(data.conflicts) || data.conflicts.length > 100) failed()
  const projection = data.projection === null ? null : projectionJob(data.projection, 'historical')
  const conflicts = data.conflicts.map((value) => {
    if (!exact(value, ['id', 'sourceRecordId', 'kind', 'context'])
      || !identifier(value.id, 'hcf') || !identifier(value.sourceRecordId, 'wbs')
      || !['classification', 'service', 'near_match'].includes(value.kind)) failed()
    const context = reviewContext(value.context)
    return Object.freeze({
      conflictId: value.id, sourceRecordId: value.sourceRecordId, kind: value.kind, context,
    })
  })
  return Object.freeze({ projection, conflicts: Object.freeze(conflicts) })
}

function redactedHistoricalProjection(value) {
  return Object.freeze({
    projection: value.projection,
    conflicts: Object.freeze(value.conflicts.map((conflict) => Object.freeze({
      conflictId: conflict.conflictId,
      sourceRecordId: conflict.sourceRecordId,
      kind: conflict.kind,
    }))),
  })
}

function reviewResolution(value) {
  if (value === null) return null
  if (!exact(value, ['classification', 'existingSubjectId', 'serviceId'])
    || !['person', 'counterparty', 'exclude'].includes(value.classification)
    || !(value.existingSubjectId === null || subjectIdentifier(value.existingSubjectId))
    || !(value.serviceId === null || (typeof value.serviceId === 'string'
      && value.serviceId.length >= 1 && value.serviceId.length <= 80))) failed()
  return Object.freeze({
    classification: value.classification,
    existingSubjectId: value.existingSubjectId,
    serviceId: value.serviceId,
  })
}

function reviewCatalogData(data, expected) {
  const keys = [
    'binding', 'afterSourceRecordId', 'nextAfterSourceRecordId', 'directoryCount',
    'directoryDigest', 'items', 'profiles',
  ]
  if (!exact(data, keys) || !exact(data.binding, REVIEW_BINDING_KEYS)
    || data.binding.environment !== 'staging' || data.binding.centreId !== 'centre_1'
    || data.binding.fingerprint !== APPROVED_WORKBOOK_FINGERPRINT
    || data.binding.importId !== expected.importId
    || data.binding.creatorId !== expected.creatorId
    || !identifier(data.binding.artifactId, 'wba')
    || !/^v1_[A-Za-z0-9_-]{43}$/.test(data.binding.planDigest ?? '')
    || data.afterSourceRecordId !== expected.afterSourceRecordId
    || !(data.nextAfterSourceRecordId === null
      || identifier(data.nextAfterSourceRecordId, 'wbs'))
    || !Number.isSafeInteger(data.directoryCount) || data.directoryCount < 0
    || !/^[a-f0-9]{64}$/.test(data.directoryDigest ?? '')
    || !Array.isArray(data.items) || data.items.length > 100
    || !Array.isArray(data.profiles) || data.profiles.length > 100) failed()
  const privateItems = data.items.map((value) => {
    if (!exact(value, ['sourceRecordId', 'kind', 'conflictId', 'resolution',
      'reviewContextDigest', 'context'])
      || !identifier(value.sourceRecordId, 'wbs')
      || !['classification', 'service'].includes(value.kind)
      || !(value.conflictId === null || identifier(value.conflictId, 'hcf'))
      || !/^[a-f0-9]{64}$/.test(value.reviewContextDigest ?? '')) failed()
    const context = reviewContext(value.context)
    return Object.freeze({
      sourceRecordId: value.sourceRecordId,
      kind: value.kind,
      conflictId: value.conflictId,
      resolution: reviewResolution(value.resolution),
      reviewContextDigest: value.reviewContextDigest,
      context,
    })
  })
  const privateProfiles = data.profiles.map((value) => {
    if (!exact(value, ['sourceRecordId', 'reviewContextDigest', 'context'])
      || !identifier(value.sourceRecordId, 'wbs')
      || !/^[a-f0-9]{64}$/.test(value.reviewContextDigest ?? '')) failed()
    return Object.freeze({
      sourceRecordId: value.sourceRecordId,
      reviewContextDigest: value.reviewContextDigest,
      context: reviewContext(value.context),
    })
  })
  const page = Object.freeze({
    binding: Object.freeze(Object.fromEntries(
      REVIEW_BINDING_KEYS.map((key) => [key, data.binding[key]]),
    )),
    afterSourceRecordId: data.afterSourceRecordId,
    nextAfterSourceRecordId: data.nextAfterSourceRecordId,
    directoryCount: data.directoryCount,
    directoryDigest: data.directoryDigest,
    items: Object.freeze(privateItems),
    profiles: Object.freeze(privateProfiles),
  })
  return page
}

function redactedReviewPage(page) {
  return Object.freeze({
    binding: page.binding,
    afterSourceRecordId: page.afterSourceRecordId,
    nextAfterSourceRecordId: page.nextAfterSourceRecordId,
    directoryCount: page.directoryCount,
    directoryDigest: page.directoryDigest,
    items: Object.freeze(page.items.map((value) => Object.freeze({
      sourceRecordId: value.sourceRecordId,
      kind: value.kind,
      conflictId: value.conflictId,
      resolution: value.resolution,
      reviewContextDigest: value.reviewContextDigest,
    }))),
    profiles: Object.freeze(page.profiles.map((value) => Object.freeze({
      sourceRecordId: value.sourceRecordId,
      reviewContextDigest: value.reviewContextDigest,
    }))),
  })
}

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
    jobId: create ? null : data.job.id,
    jobVersion: create ? null : data.job.version,
    status: data.import.status,
    version: data.import.version,
    createdRecords: evidence.createdRecords ?? 0,
    voidedRecords: evidence.voidedRecords ?? 0,
    converged: evidence.converged ?? false,
  }
}

function discoveryState(value) {
  const keys = [
    'artifactId', 'converged', 'createdRecords', 'importId', 'status', 'version',
    'voidedRecords',
  ]
  if (!exact(value, keys) || !identifier(value.importId, 'wbi')
    || !identifier(value.artifactId, 'wba')
    || !['ready', 'materializing', 'complete', 'failed'].includes(value.status)
    || !Number.isSafeInteger(value.version) || value.version < 1
    || !Number.isSafeInteger(value.createdRecords) || value.createdRecords < 0
    || !Number.isSafeInteger(value.voidedRecords) || value.voidedRecords < 0
    || typeof value.converged !== 'boolean'
    || value.converged !== (value.status === 'complete')) failed()
  return Object.freeze({
    ...Object.fromEntries(keys.map((key) => [key, value[key]])),
    jobId: null,
    jobVersion: null,
  })
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
    async discoverImport({ fingerprint, creatorId }) {
      if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '') || creatorId !== expectedActorId) failed()
      const data = await getJson(
        `/api/v1/workbooks/imports/discovery?fingerprint=${fingerprint}`,
      )
      if (!exact(data, ['import'])) failed()
      return data.import === null ? null : discoveryState(data.import)
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
    async historicalReviewCatalog({ importId, afterSourceRecordId, consumeReviewPage = null }) {
      if (!identifier(importId, 'wbi')
        || !(afterSourceRecordId === null || identifier(afterSourceRecordId, 'wbs'))
        || !(consumeReviewPage === null || typeof consumeReviewPage === 'function')) failed()
      const path = `/api/v1/workbooks/imports/${importId}/historical-projection/review-catalog${
        afterSourceRecordId === null ? '' : `?afterSourceRecordId=${afterSourceRecordId}`
      }`
      const privatePage = reviewCatalogData(await getJson(path), {
        importId, creatorId: expectedActorId, afterSourceRecordId,
      })
      if (consumeReviewPage !== null) await consumeReviewPage(privatePage)
      return redactedReviewPage(privatePage)
    },
    async historicalProjection(importId, { consumeConflictReview = null } = {}) {
      if (!identifier(importId, 'wbi')
        || !(consumeConflictReview === null || typeof consumeConflictReview === 'function')) {
        failed()
      }
      const privateProjection = historicalProjectionData(await getJson(
        `/api/v1/workbooks/imports/${importId}/historical-projection`,
      ))
      if (consumeConflictReview !== null) await consumeConflictReview(privateProjection)
      return redactedHistoricalProjection(privateProjection)
    },
    async continueHistoricalProjection({ importId, expectedVersion, idempotencyKey }) {
      if (!identifier(importId, 'wbi') || !Number.isSafeInteger(expectedVersion)
        || expectedVersion < 0 || typeof idempotencyKey !== 'string') failed()
      const path = `/api/v1/workbooks/imports/${importId}/historical-projection/continue`
      const request = await postMutation(path, () => ({
        headers: mutationHeaders(idempotencyKey), data: { expectedVersion },
      }))
      const data = await json(request.response, request.expectedUrl)
      if (!exact(data, ['projection']) || !plain(data.projection)) failed()
      return projectionJob(data.projection, 'historical')
    },
    async resolveHistoricalProjection(input) {
      const keys = [
        'importId', 'expectedJobVersion', 'conflictId', 'classification',
        'existingSubjectId', 'serviceId', 'reviewContextDigest', 'directoryCount',
        'directoryDigest', 'idempotencyKey',
      ]
      if (!exact(input, keys) || !identifier(input.importId, 'wbi')
        || !Number.isSafeInteger(input.expectedJobVersion) || input.expectedJobVersion < 1
        || !identifier(input.conflictId, 'hcf')
        || !['person', 'counterparty', 'exclude'].includes(input.classification)
        || !(input.existingSubjectId === null || subjectIdentifier(input.existingSubjectId))
        || !(input.serviceId === null || (typeof input.serviceId === 'string'
          && input.serviceId.length >= 1 && input.serviceId.length <= 80))
        || !/^[a-f0-9]{64}$/.test(input.reviewContextDigest ?? '')
        || !Number.isSafeInteger(input.directoryCount) || input.directoryCount < 0
        || !/^[a-f0-9]{64}$/.test(input.directoryDigest ?? '')
        || typeof input.idempotencyKey !== 'string') failed()
      const path = `/api/v1/workbooks/imports/${input.importId}/historical-projection/resolutions`
      const request = await postMutation(path, () => ({
        headers: mutationHeaders(input.idempotencyKey),
        data: Object.fromEntries(keys.slice(1, -1).map((key) => [key, input[key]])),
      }))
      const data = await json(request.response, request.expectedUrl)
      if (!exact(data, ['projection']) || !plain(data.projection)) failed()
      return projectionJob(data.projection, 'historical')
    },
    async activityProjection(importId) {
      if (!identifier(importId, 'wbi')) failed()
      const data = await getJson(`/api/v1/workbooks/imports/${importId}/activity-projection`)
      if (!exact(data, ['job']) || !(data.job === null || plain(data.job))) failed()
      return data.job === null ? null : projectionJob(data.job, 'activity')
    },
    async continueActivityProjection({ importId, expectedVersion, idempotencyKey }) {
      if (!identifier(importId, 'wbi') || !Number.isSafeInteger(expectedVersion)
        || expectedVersion < 0 || typeof idempotencyKey !== 'string') failed()
      const path = `/api/v1/workbooks/imports/${importId}/activity-projection/continue`
      const request = await postMutation(path, () => ({
        headers: mutationHeaders(idempotencyKey), data: { expectedVersion },
      }))
      const data = await json(request.response, request.expectedUrl)
      if (!exact(data, ['job']) || !plain(data.job)) failed()
      return projectionJob(data.job, 'activity')
    },
    async refreshAuthority() {
      await refresh()
    },
    async exportWorkbook({ format, idempotencyKey }) {
      if (!['legacy', 'panel-v2'].includes(format) || !idempotencyKey) failed()
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
