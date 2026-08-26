import { pathToFileURL } from 'node:url'
import { acceptPhaseOneAccessEmail } from '../worker/identity/canonical-email.js'
import {
  buildBootstrapCreationBatch,
  inspectBootstrapAggregate,
  inspectBootstrapEntryState,
  inspectBootstrapSchema,
} from './bootstrap-core.js'
import { loadAccessProviderConfig } from '../worker/config.js'
import { isD1OutboxOperationGuardFailure } from '../worker/db/errors.js'
import { dispatchOutboxJob } from '../worker/jobs/handlers.js'
import { processOutboxJobById } from '../worker/jobs/outbox.js'
import { decodeBase64Url, encodeBase64Url } from '../worker/security/encoding.js'
import { createKeyring } from '../worker/security/keyring.js'

const ACCOUNT_ID = /^[0-9a-f]{32}$/
const PROVIDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const D1_REST_DEADLINE_MS = 15_000
const MAX_PARAM_BYTES = 16_384
const MAX_REQUEST_BYTES = 65_536
const MAX_RESPONSE_BYTES = 65_536
const MAX_SQL_BYTES = 65_536
const MAX_SQL_PARAMS = 256
const INPUT_KEYS = Object.freeze([
  'APP_ENV',
  'APP_ORIGIN',
  'BOOTSTRAP_OWNER_DISPLAY_NAME',
  'BOOTSTRAP_OWNER_EMAIL',
  'BOOTSTRAP_TARGET',
  'BWM_BACKUP_KEK_V1',
  'BWM_DATA_KEK_V1',
  'BWM_LOOKUP_HMAC_V1',
  'CF_ACCESS_GROUP_ID',
  'CF_ACCESS_GROUP_NAME',
  'CF_ACCESS_GROUP_TOKEN',
  'CF_ACCOUNT_ID',
  'CF_D1_BOOTSTRAP_TOKEN',
  'CF_D1_DATABASE_ID',
  'DATA_MODE',
])

const ownObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const fail = (code) => {
  throw new Error(code)
}
const facadeFail = () => fail('D1_FACADE_INPUT_INVALID')
const canonicalKey = (value) => {
  let raw
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false
    raw = decodeBase64Url(value)
    return raw.byteLength === 32 && encodeBase64Url(raw) === value
  } catch {
    return false
  } finally {
    raw?.fill(0)
  }
}
const saneSecret = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 4096
  && !/\s/u.test(value)
const canonicalDisplayName = (value) => typeof value === 'string'
  && value === value.normalize('NFC')
  && value === value.trim()
  && value.length > 0
  && new TextEncoder().encode(value).byteLength <= 120
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
const canonicalEmail = (value) => acceptPhaseOneAccessEmail(value, {
  appEnv: 'staging',
}) !== null

const parseJsonWithoutDuplicateKeys = (source) => {
  let cursor = 0

  const invalid = () => fail('D1_REST_RESPONSE_INVALID')
  const whitespace = () => {
    while (/[\t\n\r ]/.test(source[cursor] ?? '')) cursor += 1
  }
  const stringToken = () => {
    if (source[cursor] !== '"') invalid()
    const start = cursor
    cursor += 1
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2
      } else if (source[cursor] === '"') {
        cursor += 1
        try {
          return JSON.parse(source.slice(start, cursor))
        } catch {
          invalid()
        }
      } else {
        cursor += 1
      }
    }
    invalid()
  }
  const value = (depth) => {
    if (depth > 64) invalid()
    whitespace()
    if (source[cursor] === '{') {
      cursor += 1
      whitespace()
      const keys = new Set()
      if (source[cursor] === '}') {
        cursor += 1
        return
      }
      for (;;) {
        const key = stringToken()
        if (keys.has(key)) invalid()
        keys.add(key)
        whitespace()
        if (source[cursor] !== ':') invalid()
        cursor += 1
        value(depth + 1)
        whitespace()
        if (source[cursor] === '}') {
          cursor += 1
          return
        }
        if (source[cursor] !== ',') invalid()
        cursor += 1
        whitespace()
      }
    }
    if (source[cursor] === '[') {
      cursor += 1
      whitespace()
      if (source[cursor] === ']') {
        cursor += 1
        return
      }
      for (;;) {
        value(depth + 1)
        whitespace()
        if (source[cursor] === ']') {
          cursor += 1
          return
        }
        if (source[cursor] !== ',') invalid()
        cursor += 1
      }
    }
    if (source[cursor] === '"') {
      stringToken()
      return
    }
    const start = cursor
    while (cursor < source.length && !/[\t\n\r ,\]}]/.test(source[cursor])) cursor += 1
    if (cursor === start) invalid()
  }

  if (typeof source !== 'string') invalid()
  value(0)
  whitespace()
  if (cursor !== source.length) invalid()
  try {
    return JSON.parse(source)
  } catch {
    invalid()
  }
}

const readResponsePart = async (reader, signal) => {
  if (signal.aborted) {
    try { Promise.resolve(reader.cancel()).catch(() => {}) } catch { /* Best effort. */ }
    fail('D1_REST_AMBIGUOUS')
  }
  let onAbort
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve({ kind: 'aborted' })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const reading = Promise.resolve()
    .then(() => reader.read())
    .then(
      (part) => ({ kind: 'read', part }),
      () => ({ kind: 'read-error' }),
    )
  const outcome = await Promise.race([reading, aborted])
  signal.removeEventListener('abort', onAbort)
  if (outcome.kind === 'aborted') {
    try { Promise.resolve(reader.cancel()).catch(() => {}) } catch { /* Best effort. */ }
    fail('D1_REST_AMBIGUOUS')
  }
  if (outcome.kind === 'read-error') fail('D1_REST_RESPONSE_INVALID')
  return outcome.part
}

const responseText = async (response, signal) => {
  if (typeof response?.body?.getReader !== 'function') fail('D1_REST_RESPONSE_INVALID')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0
  let value = ''
  try {
    for (;;) {
      const part = await readResponsePart(reader, signal)
      if (part.done) break
      if (!(part.value instanceof Uint8Array)) fail('D1_REST_RESPONSE_INVALID')
      total += part.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel() } catch { /* Fixed public error. */ }
        fail('D1_REST_RESPONSE_INVALID')
      }
      value += decoder.decode(part.value, { stream: true })
    }
    value += decoder.decode()
    return value
  } catch (error) {
    if (['D1_REST_AMBIGUOUS', 'D1_REST_RESPONSE_INVALID'].includes(error?.message)) {
      throw error
    }
    fail('D1_REST_RESPONSE_INVALID')
  } finally {
    try { reader.releaseLock() } catch { /* The stream is already consumed. */ }
  }
}

const validateStatement = (statement) => {
  if (!exactKeys(statement, ['sql', 'params'])
    || typeof statement.sql !== 'string'
    || statement.sql.length < 1
    || new TextEncoder().encode(statement.sql).byteLength > MAX_SQL_BYTES
    || statement.sql !== statement.sql.trim()
    || !Array.isArray(statement.params)
    || statement.params.length > MAX_SQL_PARAMS
    || !statement.params.every((value) => typeof value === 'string'
      && new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_PARAM_BYTES)) {
    fail('D1_REST_INPUT_INVALID')
  }
  return { sql: statement.sql, params: [...statement.params] }
}

const validResultValue = (value) => value === null
  || typeof value === 'string'
  || (typeof value === 'number' && Number.isFinite(value))
const validResultRow = (row) => ownObject(row)
  && Object.values(row).every(validResultValue)
const META_TYPES = Object.freeze({
  changed_db: 'boolean',
  changes: 'number',
  duration: 'number',
  last_row_id: 'number',
  rows_read: 'number',
  rows_written: 'number',
  served_by: 'string',
  served_by_colo: 'string',
  served_by_primary: 'boolean',
  size_after: 'number',
  total_attempts: 'number',
})
const D1_REGIONS = new Set(['APAC', 'EEUR', 'ENAM', 'OC', 'WEUR', 'WNAM'])
const validMeta = (meta) => ownObject(meta)
  && Object.entries(meta).every(([key, value]) => {
    if (key === 'timings') {
      return ownObject(value)
        && Object.keys(value).every((timing) => timing === 'sql_duration_ms')
        && (!Object.hasOwn(value, 'sql_duration_ms')
          || (typeof value.sql_duration_ms === 'number'
            && Number.isFinite(value.sql_duration_ms)))
    }
    if (key === 'served_by_region') return D1_REGIONS.has(value)
    const type = META_TYPES[key]
    return type !== undefined
      && typeof value === type
      && (type !== 'number' || Number.isFinite(value))
  })

const OUTBOX_GUARD_MESSAGES = new Set([
  'outbox_operation_guard_failed: SQLITE_CONSTRAINT',
  'outbox_operation_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
  'D1_ERROR: outbox_operation_guard_failed: SQLITE_CONSTRAINT',
  'D1_ERROR: outbox_operation_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
])
const FIXED_OUTBOX_GUARD_ERROR = 'D1_ERROR: outbox_operation_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)'
const validResponseInfo = (value) => ownObject(value)
  && Object.hasOwn(value, 'code')
  && Object.hasOwn(value, 'message')
  && Object.keys(value).every((key) => [
    'code',
    'documentation_url',
    'message',
    'source',
  ].includes(key))
  && value.code === 7500
  && typeof value.message === 'string'
  && (!Object.hasOwn(value, 'documentation_url')
    || typeof value.documentation_url === 'string')
  && (!Object.hasOwn(value, 'source')
    || (ownObject(value.source)
      && Object.keys(value.source).every((key) => key === 'pointer')
      && (!Object.hasOwn(value.source, 'pointer')
        || typeof value.source.pointer === 'string')))
const isOutboxGuardResponse = (value) => exactKeys(
  value,
  ['errors', 'messages', 'result', 'success'],
)
  && value.success === false
  && Array.isArray(value.errors)
  && value.errors.length === 1
  && validResponseInfo(value.errors[0])
  && OUTBOX_GUARD_MESSAGES.has(value.errors[0].message)
  && Array.isArray(value.messages)
  && value.messages.length === 0
  && (value.result === null
    || (Array.isArray(value.result) && value.result.length === 0))

const validateApiResult = (value, resultCount) => {
  if (!exactKeys(value, ['errors', 'messages', 'result', 'success'])
    || value.success !== true
    || !Array.isArray(value.errors)
    || value.errors.length !== 0
    || !Array.isArray(value.messages)
    || value.messages.length !== 0
    || !Array.isArray(value.result)
    || value.result.length !== resultCount) fail('D1_REST_RESPONSE_INVALID')
  return value.result.map((result) => {
    if (!exactKeys(result, ['meta', 'results', 'success'])
      || result.success !== true
      || !validMeta(result.meta)
      || !Array.isArray(result.results)
      || !result.results.every(validResultRow)) fail('D1_REST_RESPONSE_INVALID')
    return result.results
  })
}

const rewriteD1Bindings = (sql) => {
  if (typeof sql !== 'string'
    || sql.length < 1
    || sql !== sql.trim()
    || new TextEncoder().encode(sql).byteLength > MAX_SQL_BYTES) facadeFail()
  let state = 'plain'
  let placeholders = 0
  let rewritten = ''
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    const next = sql[index + 1]
    if (state === 'line-comment') {
      rewritten += character
      if (character === '\n') state = 'plain'
      continue
    }
    if (state === 'block-comment') {
      rewritten += character
      if (character === '*' && next === '/') {
        rewritten += next
        index += 1
        state = 'plain'
      }
      continue
    }
    if (state === 'bracket') {
      rewritten += character
      if (character === ']') state = 'plain'
      continue
    }
    if (state !== 'plain') {
      rewritten += character
      if (character === state) {
        if (next === state) {
          rewritten += next
          index += 1
        } else {
          state = 'plain'
        }
      }
      continue
    }
    if (character === '-' && next === '-') {
      rewritten += `${character}${next}`
      index += 1
      state = 'line-comment'
    } else if (character === '/' && next === '*') {
      rewritten += `${character}${next}`
      index += 1
      state = 'block-comment'
    } else if (character === "'" || character === '"' || character === '`') {
      rewritten += character
      state = character
    } else if (character === '[') {
      rewritten += character
      state = 'bracket'
    } else if (character === '?') {
      if (/\d/.test(next ?? '')) facadeFail()
      placeholders += 1
      if (placeholders > MAX_SQL_PARAMS) facadeFail()
      rewritten += "json_extract(?, '$')"
    } else {
      rewritten += character
    }
  }
  if (!['plain', 'line-comment'].includes(state)
    || new TextEncoder().encode(rewritten).byteLength > MAX_SQL_BYTES) facadeFail()
  return Object.freeze({ placeholders, sql: rewritten })
}

const canonicalD1Binding = (value) => {
  if (value === null || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  facadeFail()
}

export function normalizeBootstrapInput(env, argv = []) {
  if (!ownObject(env) || !Array.isArray(argv) || argv.length !== 0) {
    fail('BOOTSTRAP_INPUT_INVALID')
  }
  const selected = Object.fromEntries(INPUT_KEYS.map((key) => [key, env[key]]))
  if (selected.APP_ENV !== 'staging'
    || selected.BOOTSTRAP_TARGET !== 'staging'
    || selected.DATA_MODE !== 'fictional'
    || selected.APP_ORIGIN !== 'https://staging.bearwithme-panel.app'
    || !canonicalDisplayName(selected.BOOTSTRAP_OWNER_DISPLAY_NAME)
    || !canonicalEmail(selected.BOOTSTRAP_OWNER_EMAIL)
    || !ACCOUNT_ID.test(selected.CF_ACCOUNT_ID ?? '')
    || !PROVIDER_UUID.test(selected.CF_D1_DATABASE_ID ?? '')
    || !PROVIDER_UUID.test(selected.CF_ACCESS_GROUP_ID ?? '')
    || !saneSecret(selected.CF_D1_BOOTSTRAP_TOKEN)
    || selected.CF_D1_BOOTSTRAP_TOKEN === selected.CF_ACCESS_GROUP_TOKEN
    || !canonicalKey(selected.BWM_DATA_KEK_V1)
    || !canonicalKey(selected.BWM_LOOKUP_HMAC_V1)
    || !canonicalKey(selected.BWM_BACKUP_KEK_V1)) {
    fail('BOOTSTRAP_INPUT_INVALID')
  }
  try {
    loadAccessProviderConfig(selected, { appEnv: 'staging' })
  } catch {
    fail('BOOTSTRAP_INPUT_INVALID')
  }
  return Object.freeze({
    accessBindings: Object.freeze({
      CF_ACCESS_GROUP_ID: selected.CF_ACCESS_GROUP_ID,
      CF_ACCESS_GROUP_NAME: selected.CF_ACCESS_GROUP_NAME,
      CF_ACCESS_GROUP_TOKEN: selected.CF_ACCESS_GROUP_TOKEN,
      CF_ACCOUNT_ID: selected.CF_ACCOUNT_ID,
    }),
    accountId: selected.CF_ACCOUNT_ID,
    activeBackupKekVersion: 1,
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    appEnv: selected.APP_ENV,
    appOrigin: selected.APP_ORIGIN,
    bootstrapTarget: selected.BOOTSTRAP_TARGET,
    dataMode: selected.DATA_MODE,
    databaseId: selected.CF_D1_DATABASE_ID,
    d1Token: selected.CF_D1_BOOTSTRAP_TOKEN,
    keyringBindings: Object.freeze({
      BWM_BACKUP_KEK_V1: selected.BWM_BACKUP_KEK_V1,
      BWM_DATA_KEK_V1: selected.BWM_DATA_KEK_V1,
      BWM_LOOKUP_HMAC_V1: selected.BWM_LOOKUP_HMAC_V1,
    }),
    ownerDisplayName: selected.BOOTSTRAP_OWNER_DISPLAY_NAME,
    ownerEmail: selected.BOOTSTRAP_OWNER_EMAIL,
  })
}

export function createD1RestClient({
  accountId,
  deadlineSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  databaseId,
  token,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (!ACCOUNT_ID.test(accountId ?? '')
    || !PROVIDER_UUID.test(databaseId ?? '')
    || !saneSecret(token)
    || typeof deadlineSignal !== 'function'
    || typeof fetchImpl !== 'function') fail('D1_REST_INPUT_INVALID')
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`
  const request = async (body, expectedResults) => {
    const serialized = JSON.stringify(body)
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
      fail('D1_REST_INPUT_INVALID')
    }
    let response
    let signal
    try {
      signal = deadlineSignal(D1_REST_DEADLINE_MS)
      if (!signal || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function') fail('D1_REST_AMBIGUOUS')
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: serialized,
        redirect: 'error',
        signal,
      })
    } catch {
      fail('D1_REST_AMBIGUOUS')
    }
    if (!(response instanceof Response)) fail('D1_REST_REFUSED')
    let raw
    try {
      raw = await responseText(response, signal)
    } catch (error) {
      if (response.status < 200 || response.status >= 300) fail('D1_REST_REFUSED')
      if (['D1_REST_AMBIGUOUS', 'D1_REST_RESPONSE_INVALID'].includes(error?.message)) {
        throw error
      }
      fail('D1_REST_RESPONSE_INVALID')
    }
    let value
    try {
      value = parseJsonWithoutDuplicateKeys(raw)
    } catch (error) {
      if (response.status < 200 || response.status >= 300) fail('D1_REST_REFUSED')
      if (error?.message === 'D1_REST_RESPONSE_INVALID') throw error
      fail('D1_REST_RESPONSE_INVALID')
    }
    if (isOutboxGuardResponse(value)) throw new Error(FIXED_OUTBOX_GUARD_ERROR)
    if (response.status < 200 || response.status >= 300) fail('D1_REST_REFUSED')
    return validateApiResult(value, expectedResults)
  }
  return Object.freeze({
    endpoint,
    async query(statement) {
      const validated = validateStatement(statement)
      return (await request(validated, 1))[0]
    },
    async batch(statements) {
      if (!Array.isArray(statements) || statements.length < 1 || statements.length > 256) {
        fail('D1_REST_INPUT_INVALID')
      }
      const batch = statements.map(validateStatement)
      return request({ batch }, batch.length)
    },
  })
}

export function createD1DatabaseFacade(client) {
  if (!client || typeof client.query !== 'function' || typeof client.batch !== 'function') {
    facadeFail()
  }
  const owner = Object.freeze({})
  const descriptors = new WeakMap()

  const result = (rows) => ({
    meta: {},
    results: rows,
    success: true,
  })
  const prepared = (parsed, params = null) => {
    const executeRows = async () => {
      const descriptor = descriptors.get(statement)
      if (descriptor.params === null) facadeFail()
      return client.query({
        params: [...descriptor.params],
        sql: descriptor.sql,
      })
    }
    const statement = Object.freeze({
      all: async () => result(await executeRows()),
      bind: (...values) => {
        if (values.length !== parsed.placeholders) facadeFail()
        return prepared(parsed, values.map(canonicalD1Binding))
      },
      first: async (...args) => {
        if (args.length !== 0) facadeFail()
        return (await executeRows())[0] ?? null
      },
      run: async () => result(await executeRows()),
    })
    descriptors.set(statement, Object.freeze({
      owner,
      params: params ?? (parsed.placeholders === 0 ? Object.freeze([]) : null),
      sql: parsed.sql,
    }))
    return statement
  }

  return Object.freeze({
    async batch(statements) {
      if (!Array.isArray(statements)
        || statements.length < 1
        || statements.length > MAX_SQL_PARAMS) facadeFail()
      const batch = statements.map((statement) => {
        const descriptor = descriptors.get(statement)
        if (!descriptor || descriptor.owner !== owner || descriptor.params === null) facadeFail()
        return {
          params: [...descriptor.params],
          sql: descriptor.sql,
        }
      })
      const rows = await client.batch(batch)
      if (!Array.isArray(rows) || rows.length !== batch.length
        || !rows.every(Array.isArray)) facadeFail()
      return rows.map(result)
    },
    prepare(sql) {
      return prepared(rewriteD1Bindings(sql))
    },
  })
}

const bootstrapScope = Object.freeze({
  id: 'centre_1',
  purpose: 'identity',
  type: 'staff_directory',
})

const fixedResult = (code, ok, ids) => Object.freeze({
  code,
  ...(ids ? { ids } : {}),
  ok,
})

const sameFlatRecord = (actual, expected) => ownObject(actual)
  && ownObject(expected)
  && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => Object.is(actual[key], value))

const validateCreationProof = (results, built) => {
  const final = results?.at?.(-1)
  if (!Array.isArray(results)
    || results.length !== built?.batch?.length
    || !exactKeys(final, ['meta', 'results', 'success'])
    || !ownObject(final.meta)
    || final.success !== true
    || !Array.isArray(final.results)
    || final.results.length !== 1
    || !sameFlatRecord(final.results[0], built.proof)) {
    fail('D1_REST_RESPONSE_INVALID')
  }
}

const recoverableD1Mutation = (error) => (
  error?.message === 'D1_REST_AMBIGUOUS'
  || isD1OutboxOperationGuardFailure(error)
)

const randomSuffix = () => crypto.randomUUID().replaceAll('-', '')

async function executeBootstrapOwner(input, deps) {
  const now = deps.now ?? Date.now
  const keyringConfig = Object.freeze({
    activeBackupKekVersion: input.activeBackupKekVersion,
    activeDataKekVersion: input.activeDataKekVersion,
    activeLookupKeyVersion: input.activeLookupKeyVersion,
  })
  const keyring = deps.keyring ?? await createKeyring(
    input.keyringBindings,
    keyringConfig,
  )
  const client = deps.db
    ? null
    : createD1RestClient({
        accountId: input.accountId,
        databaseId: input.databaseId,
        deadlineSignal: deps.deadlineSignal,
        fetch: deps.d1Fetch ?? deps.fetch ?? globalThis.fetch,
        token: input.d1Token,
      })
  const db = deps.db ?? createD1DatabaseFacade(client)
  if (!db?.prepare || !db?.batch) return fixedResult('BOOTSTRAP_FAILED', false)

  const schemaInspector = deps.inspectSchema ?? inspectBootstrapSchema
  const entryInspector = deps.inspectEntryState ?? inspectBootstrapEntryState
  const aggregateInspector = deps.inspectAggregate ?? inspectBootstrapAggregate
  const creationBuilder = deps.buildCreationBatch ?? buildBootstrapCreationBatch
  const targetProcessor = deps.processTarget ?? processOutboxJobById
  const readAggregate = (nowMs) => aggregateInspector({
    db,
    keyring,
    nowMs,
    ownerDisplayName: input.ownerDisplayName,
    ownerEmail: input.ownerEmail,
  })
  const schema = await schemaInspector(db)
  if (schema.kind !== 'ready') return fixedResult('BOOTSTRAP_SCHEMA_REFUSED', false)
  const entryNowMs = now()
  if (!Number.isSafeInteger(entryNowMs) || entryNowMs < 0) {
    return fixedResult('BOOTSTRAP_FAILED', false)
  }
  const idFactory = deps.idFactory ?? randomSuffix
  const correlationIdFactory = deps.correlationIdFactory ?? (() => crypto.randomUUID())
  const leaseOwnerFactory = deps.leaseOwnerFactory ?? randomSuffix
  const leaseNonceFactory = deps.leaseNonceFactory ?? randomSuffix
  let aggregate = await entryInspector({
    db,
    keyring,
    nowMs: entryNowMs,
    ownerDisplayName: input.ownerDisplayName,
    ownerEmail: input.ownerEmail,
  })
  if (aggregate.kind === 'empty') {
    const built = await creationBuilder({
      correlationId: correlationIdFactory(),
      idFactory,
      keyring,
      keyringConfig,
      nowMs: entryNowMs,
      ownerDisplayName: input.ownerDisplayName,
      ownerEmail: input.ownerEmail,
      scope: bootstrapScope,
    })
    let creationError = null
    try {
      const creationResults = await db.batch(built.batch.map(({ sql, params }) => (
        db.prepare(sql).bind(...params)
      )))
      validateCreationProof(creationResults, built)
    } catch (error) {
      creationError = error
    }
    const recoveryNowMs = now()
    if (!Number.isSafeInteger(recoveryNowMs) || recoveryNowMs < entryNowMs) {
      return fixedResult('BOOTSTRAP_FAILED', false)
    }
    aggregate = await readAggregate(recoveryNowMs)
    if (aggregate.kind === 'refused' && creationError) {
      return recoverableD1Mutation(creationError)
        ? fixedResult('BOOTSTRAP_STATE_REFUSED', false)
        : fixedResult('BOOTSTRAP_FAILED', false)
    }
  }
  if (aggregate.kind === 'refused') {
    return fixedResult('BOOTSTRAP_STATE_REFUSED', false)
  }
  if (aggregate.kind === 'access-published'
    && aggregate.reconcileState === 'succeeded') {
    return fixedResult('BOOTSTRAP_ALREADY_COMPLETE', true, aggregate.ids)
  }

  const dataKey = await db.prepare('SELECT * FROM data_keys WHERE id=?')
    .bind(aggregate.ids.dataKeyId).first()
  const processNowMs = now()
  if (!Number.isSafeInteger(processNowMs) || processNowMs < entryNowMs) {
    return fixedResult('BOOTSTRAP_FAILED', false)
  }
  const dispatch = deps.dispatch ?? dispatchOutboxJob
  const providers = ownObject(deps.providers) ? deps.providers : {}
  const accessProviders = Object.freeze({
    ...providers,
    ...(deps.accessFetch ? { fetch: deps.accessFetch } : {}),
  })
  let outcome
  let targetError = null
  try {
    outcome = await targetProcessor({
      bindings: input.accessBindings,
      config: { appEnv: input.appEnv },
      correlationIdFactory,
      cryptoContext: {
        dataKey,
        keyring,
        scope: bootstrapScope,
      },
      db,
      dispatch: (dispatchInput) => dispatch({
        ...dispatchInput,
        providers: accessProviders,
      }),
      idFactory,
      jobId: aggregate.ids.reconcileJobId,
      leaseNonceFactory,
      leaseOwnerFactory,
      nowFactory: deps.nowFactory ?? now,
      nowMs: processNowMs,
    })
  } catch (error) {
    targetError = error
    outcome = { result: 'retry' }
  }
  const inspectedAt = now()
  if (!Number.isSafeInteger(inspectedAt) || inspectedAt < processNowMs) {
    return fixedResult('BOOTSTRAP_FAILED', false)
  }
  const finalAggregate = await aggregateInspector({
    db,
    keyring,
    nowMs: inspectedAt,
    ownerDisplayName: input.ownerDisplayName,
    ownerEmail: input.ownerEmail,
  })
  if (finalAggregate.kind === 'access-published'
    && finalAggregate.reconcileState === 'succeeded') {
    return fixedResult('BOOTSTRAP_COMPLETE', true, finalAggregate.ids)
  }
  if (targetError && !recoverableD1Mutation(targetError)) {
    return fixedResult('BOOTSTRAP_FAILED', false)
  }
  if (outcome?.result === 'retry'
    && (finalAggregate.kind === 'pre-reconcile'
      || finalAggregate.kind === 'access-published')) {
    return fixedResult('BOOTSTRAP_RETRY_REQUIRED', false, finalAggregate.ids)
  }
  return fixedResult('BOOTSTRAP_STATE_REFUSED', false)
}

export async function runBootstrapOwner({
  env = { ...process.env },
  argv = process.argv.slice(2),
  deps = {},
} = {}) {
  if (env?.APP_ENV === 'production' || env?.BOOTSTRAP_TARGET === 'production') {
    return Object.freeze({ code: 'BOOTSTRAP_PRODUCTION_BLOCKED', ok: false })
  }
  let input
  try {
    input = normalizeBootstrapInput(env, argv)
  } catch {
    return Object.freeze({ code: 'BOOTSTRAP_INPUT_INVALID', ok: false })
  }
  try {
    return await executeBootstrapOwner(input, deps)
  } catch {
    return Object.freeze({ code: 'BOOTSTRAP_FAILED', ok: false })
  }
}

const runCli = async () => {
  const result = await runBootstrapOwner()
  const ids = result.ids
    ? Object.entries(result.ids)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, value]) => value)
    : []
  process.stdout.write(`${[result.code, ...ids].join(' ')}\n`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}
