import { auditDescriptorFor } from '../audit/events.js'
import { isD1IdentityCollision } from './errors.js'
import { isCorrelationId } from '../logging/safe-log.js'
import { decryptForScope, encryptForScope } from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const OPERATION = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const fail = () => { throw new Error('UNIT_OF_WORK_INVALID') }
const idempotencyConflict = () => { throw new Error('IDEMPOTENCY_CONFLICT') }
const ownObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const validId = (value) => typeof value === 'string' && ID.test(value)
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const prepared = (value) => value && typeof value === 'object'
  && typeof value.bind === 'function' && typeof value.run === 'function'

export function createUnitOfWork(db, context) {
  if (!db?.batch || !ownObject(context)
    || !['mutation', 'denial'].includes(context.mode)
    || !validId(context.actorId)
    || !isCorrelationId(context.correlationId)) fail()

  const statements = []
  let guard = null
  let audits = 0
  let nonAudit = 0
  let committed = false

  const open = () => {
    if (committed) fail()
  }
  const add = (kind, statement) => {
    open()
    if (!prepared(statement)) fail()
    if (context.mode === 'denial' && kind !== 'audit') fail()
    if (kind === 'audit') {
      const descriptor = auditDescriptorFor(statement)
      if (!descriptor || descriptor.actorStaffId !== context.actorId
        || descriptor.correlationId !== context.correlationId
        || descriptor.result !== (context.mode === 'mutation' ? 'success' : 'denied')) fail()
      audits += 1
    } else {
      if (auditDescriptorFor(statement)) fail()
      nonAudit += 1
    }
    statements.push(statement)
    return api
  }

  const api = {
    domain: (statement) => add('domain', statement),
    version: (statement) => add('version', statement),
    audit: (statement) => add('audit', statement),
    outbox: (statement) => add('outbox', statement),
    idempotency: (statement) => add('idempotency', statement),
    guard(statement) {
      open()
      if (context.mode !== 'mutation' || guard || !prepared(statement)
        || auditDescriptorFor(statement)) fail()
      guard = statement
      return api
    },
    async commit() {
      open()
      committed = true
      if (audits !== 1) fail()
      if (context.mode === 'mutation' && (nonAudit < 1 || !guard)) fail()
      if (context.mode === 'denial' && (nonAudit !== 0 || guard || statements.length !== 1)) fail()
      return db.batch(guard ? [...statements, guard] : statements)
    },
  }
  return Object.freeze(api)
}

const canonicalize = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalize)
  if (ownObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  throw new Error('IDEMPOTENCY_INVALID')
}

const canonicalJson = (value) => JSON.stringify(canonicalize(value))

function validateInput(input, keys) {
  if (!ownObject(input) || Object.keys(input).length !== keys.length
    || !keys.every((key) => Object.hasOwn(input, key))
    || !validId(input.actorId) || !OPERATION.test(input.operation ?? '')
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey ?? '')
    || typeof input.requestDigest !== 'string' || input.requestDigest.length < 1 || input.requestDigest.length > 1024
    || !ownObject(input.expectedScope)) throw new Error('IDEMPOTENCY_INVALID')
  return input
}

async function stableRecordId(input) {
  const encoded = new TextEncoder().encode(
    ['bwm:idempotency:record:v1', input.actorId, input.operation, input.idempotencyKey].join('\n')
  )
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
    return `idem_${encodeBase64Url(digest)}`
  } finally {
    encoded.fill(0)
    digest?.fill(0)
  }
}

async function exactRow(db, input) {
  return db.prepare(
    `SELECT request_hash,response_envelope
     FROM idempotency_records
     WHERE actor_id=? AND operation=? AND idempotency_key=?`
  ).bind(input.actorId, input.operation, input.idempotencyKey).first()
}

async function inspectRow(row, cryptoContext, input) {
  const recordId = await stableRecordId(input)
  let storedDigest
  let response
  try {
    storedDigest = await decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
      expectedScope: input.expectedScope,
      recordId,
      field: 'idempotency_request_hash',
      envelope: JSON.parse(row.request_hash),
    })
    if (storedDigest !== input.requestDigest) idempotencyConflict()
    response = JSON.parse(await decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
      expectedScope: input.expectedScope,
      recordId,
      field: 'idempotency_response',
      envelope: JSON.parse(row.response_envelope),
    }))
    if (!ownObject(response) || !Number.isSafeInteger(response.status)
      || response.status < 200 || response.status > 299 || !Object.hasOwn(response, 'body')) {
      throw new Error('CRYPTO_FAILURE')
    }
    return Object.freeze({ status: response.status, body: canonicalize(response.body) })
  } catch (error) {
    if (error?.message === 'IDEMPOTENCY_CONFLICT') throw error
    throw new Error('CRYPTO_FAILURE')
  }
}

export async function inspectIdempotency(db, cryptoContext, input) {
  validateInput(input, ['actorId', 'operation', 'idempotencyKey', 'requestDigest', 'expectedScope'])
  const row = await exactRow(db, input)
  return row ? inspectRow(row, cryptoContext, input) : null
}

export async function createIdempotencyStatement(db, cryptoContext, input) {
  validateInput(input, [
    'actorId', 'operation', 'idempotencyKey', 'requestDigest', 'expectedScope',
    'resourceType', 'resourceId', 'response', 'createdAt', 'expiresAt',
  ])
  if (!validId(input.resourceType) || !validId(input.resourceId)
    || !validInstant(input.createdAt) || !validInstant(input.expiresAt)
    || !ownObject(input.response) || !Number.isSafeInteger(input.response.status)
    || input.response.status < 200 || input.response.status > 299
    || !Object.hasOwn(input.response, 'body')) throw new Error('IDEMPOTENCY_INVALID')
  const recordId = await stableRecordId(input)
  const requestHash = JSON.stringify(await encryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
    expectedScope: input.expectedScope,
    recordId,
    field: 'idempotency_request_hash',
    plaintext: input.requestDigest,
  }))
  const responseEnvelope = JSON.stringify(await encryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
    expectedScope: input.expectedScope,
    recordId,
    field: 'idempotency_response',
    plaintext: canonicalJson(input.response),
  }))
  return db.prepare(
    `INSERT INTO idempotency_records
     (actor_id,operation,idempotency_key,request_hash,resource_type,resource_id,response_envelope,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    input.actorId, input.operation, input.idempotencyKey, requestHash,
    input.resourceType, input.resourceId, responseEnvelope, input.createdAt, input.expiresAt,
  )
}

export async function recoverIdempotencyAfterCollision(db, cryptoContext, input, originalError) {
  if (!isD1IdentityCollision(originalError)) throw originalError
  validateInput(input, ['actorId', 'operation', 'idempotencyKey', 'requestDigest', 'expectedScope'])
  const row = await exactRow(db, input)
  if (!row) throw originalError
  return inspectRow(row, cryptoContext, input)
}
