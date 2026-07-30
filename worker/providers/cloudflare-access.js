const ACCOUNT_ID = /^[0-9a-f]{32}$/
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EMAIL = /^[^@\s]+@example\.test$/
const MAX_TIMEOUT_MS = 15_000
const MAX_RULE_DEPTH = 16
const MAX_RULE_ITEMS = 1_000
const MAX_RESPONSE_BYTES = 65_536
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const textEncoder = new TextEncoder()
const providerErrors = new WeakSet()

const endpoint = ({ accountId, groupId }) => (
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/groups/${groupId}`
)
const retryableStatus = (status) => status === 429 || status >= 500
const fail = (code, retryable = false) => {
  const error = Object.assign(new Error(code), { retryable })
  providerErrors.add(error)
  throw error
}
const ownObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const dataProperty = (object, key) => {
  if (!ownObject(object)) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
  return descriptor.value
}
const canonicalEmail = (value) => typeof value === 'string'
  && value === value.trim()
  && value === value.toLowerCase()
  && value.length <= 254
  && EMAIL.test(value)
const validGroupName = (value) => typeof value === 'string'
  && value === value.trim()
  && value.length > 0
  && textEncoder.encode(value).byteLength <= 120
  && !/[\u0000-\u001f\u007f]/u.test(value)

function cloneControlledJson(value, depth = 0) {
  if (depth > MAX_RULE_DEPTH) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    return value
  }
  if (typeof value === 'string') {
    if (textEncoder.encode(value).byteLength > 4096) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_RULE_ITEMS) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    return value.map((item) => cloneControlledJson(item, depth + 1))
  }
  if (!ownObject(value)) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (keys.length > 128) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
  const clone = {}
  for (const key of keys.sort()) {
    if (UNSAFE_KEYS.has(key)) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    }
    clone[key] = cloneControlledJson(descriptor.value, depth + 1)
  }
  return clone
}

function exactEmailRules(value) {
  if (!Array.isArray(value) || value.length > MAX_RULE_ITEMS) {
    fail('ACCESS_PROVIDER_RESPONSE_INVALID')
  }
  return value.map((rule) => {
    if (!ownObject(rule) || Object.keys(rule).length !== 1 || !Object.hasOwn(rule, 'email')) {
      fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    }
    const nested = dataProperty(rule, 'email')
    if (!ownObject(nested) || Object.keys(nested).length !== 1
      || !Object.hasOwn(nested, 'email')) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    const email = dataProperty(nested, 'email')
    if (!canonicalEmail(email)) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    return { email: { email } }
  })
}

function controlledRules(value) {
  if (!Array.isArray(value) || value.length > MAX_RULE_ITEMS) {
    fail('ACCESS_PROVIDER_RESPONSE_INVALID')
  }
  return value.map((rule) => {
    const clone = cloneControlledJson(rule)
    const keys = ownObject(clone) ? Object.keys(clone) : []
    if (keys.length !== 1 || !ownObject(clone[keys[0]])
      || Object.keys(clone[keys[0]]).length < 1) {
      fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    }
    return clone
  })
}

function exactGroup(body, input) {
  const success = dataProperty(body, 'success')
  const group = dataProperty(body, 'result')
  if (success !== true || !ownObject(group)) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
  const id = dataProperty(group, 'id')
  const name = dataProperty(group, 'name')
  if (id !== input.groupId || name !== input.groupName) fail('ACCESS_PROVIDER_GROUP_DRIFT')
  const include = exactEmailRules(dataProperty(group, 'include'))
  const require = controlledRules(dataProperty(group, 'require'))
  const exclude = controlledRules(dataProperty(group, 'exclude'))
  return Object.freeze({
    include,
    require,
    exclude,
  })
}

function validateInput(input) {
  if (!ownObject(input)
    || typeof input.fetch !== 'function'
    || !ACCOUNT_ID.test(input.accountId ?? '')
    || !GROUP_ID.test(input.groupId ?? '')
    || !validGroupName(input.groupName)
    || typeof input.token !== 'string'
    || input.token.length < 1
    || input.token.length > 4096
    || /\s/u.test(input.token)
    || !Array.isArray(input.emails)) fail('ACCESS_PROVIDER_CONFIG_INVALID')
  const timeoutMs = input.timeoutMs ?? MAX_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail('ACCESS_PROVIDER_CONFIG_INVALID')
  }
  const emails = [...new Set(input.emails)]
  if (!emails.every(canonicalEmail)) fail('ACCESS_PROVIDER_CONFIG_INVALID')
  emails.sort()
  const AbortControllerImpl = input.AbortController ?? globalThis.AbortController
  const setTimeoutImpl = input.setTimeout ?? globalThis.setTimeout
  const clearTimeoutImpl = input.clearTimeout ?? globalThis.clearTimeout
  if (typeof AbortControllerImpl !== 'function'
    || typeof setTimeoutImpl !== 'function'
    || typeof clearTimeoutImpl !== 'function') fail('ACCESS_PROVIDER_CONFIG_INVALID')
  return {
    emails,
    timeoutMs,
    AbortControllerImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
  }
}

async function responseBodyJson(response, controller) {
  let abortListener
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(new Error('ACCESS_PROVIDER_BODY_ABORTED'))
    if (controller.signal.aborted) abortListener()
    else controller.signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader()
      const chunks = []
      let length = 0
      let cancelled = false
      const cancel = async () => {
        if (cancelled || typeof reader.cancel !== 'function') return
        cancelled = true
        try {
          await Promise.race([
            Promise.resolve().then(() => reader.cancel()),
            aborted,
          ])
        } catch {
          // Cancellation is best-effort; its transport details are never public.
        }
      }
      try {
        while (true) {
          const part = await Promise.race([reader.read(), aborted])
          if (!part || typeof part.done !== 'boolean') {
            fail('ACCESS_PROVIDER_RESPONSE_INVALID')
          }
          if (part.done) break
          if (!(part.value instanceof Uint8Array)) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
          length += part.value.byteLength
          if (length > MAX_RESPONSE_BYTES) fail('ACCESS_PROVIDER_RESPONSE_INVALID')
          chunks.push(part.value)
        }
      } catch (error) {
        await cancel()
        if (controller.signal.aborted || providerErrors.has(error)) throw error
        fail('ACCESS_PROVIDER_NETWORK', true)
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } finally {
        bytes.fill(0)
      }
    }
    if (typeof response.json !== 'function') fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    return await Promise.race([response.json(), aborted])
  } finally {
    if (abortListener) controller.signal.removeEventListener('abort', abortListener)
  }
}

async function request(input, validated, method, body) {
  const controller = new validated.AbortControllerImpl()
  const timer = validated.setTimeoutImpl(() => controller.abort(), validated.timeoutMs)
  let fetchAbortListener
  const fetchAborted = new Promise((_, reject) => {
    fetchAbortListener = () => reject(new Error('ACCESS_PROVIDER_FETCH_ABORTED'))
    if (controller.signal.aborted) fetchAbortListener()
    else controller.signal.addEventListener('abort', fetchAbortListener, { once: true })
  })
  let response
  try {
    try {
      response = await Promise.race([
        Promise.resolve().then(() => input.fetch(endpoint(input), {
          method,
          headers: method === 'PUT'
            ? {
                Authorization: `Bearer ${input.token}`,
                'Content-Type': 'application/json',
              }
            : { Authorization: `Bearer ${input.token}` },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        })),
        fetchAborted,
      ])
    } finally {
      if (fetchAbortListener) {
        controller.signal.removeEventListener('abort', fetchAbortListener)
      }
    }
    if (!response || typeof response.ok !== 'boolean'
      || !Number.isInteger(response.status)
      || response.status < 100
      || response.status > 599
      || response.ok !== (response.status >= 200 && response.status < 300)) {
      fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    }
    if (!response.ok) fail('ACCESS_PROVIDER_HTTP', retryableStatus(response.status))
    const responseBody = cloneControlledJson(await responseBodyJson(response, controller))
    if (controller.signal.aborted) fail('ACCESS_PROVIDER_TIMEOUT', true)
    if (textEncoder.encode(JSON.stringify(responseBody)).byteLength > MAX_RESPONSE_BYTES) {
      fail('ACCESS_PROVIDER_RESPONSE_INVALID')
    }
    return exactGroup(responseBody, input)
  } catch (error) {
    if (controller.signal.aborted) fail('ACCESS_PROVIDER_TIMEOUT', true)
    if (providerErrors.has(error)) throw error
    if (response === undefined) fail('ACCESS_PROVIDER_NETWORK', true)
    fail('ACCESS_PROVIDER_RESPONSE_INVALID')
  } finally {
    validated.clearTimeoutImpl(timer)
  }
}

const sameRules = (left, right) => JSON.stringify(left) === JSON.stringify(right)

export async function reconcileAccessGroup(input = {}) {
  const validated = validateInput(input)
  const current = await request(input, validated, 'GET')
  const include = validated.emails.map((email) => ({ email: { email } }))
  const payload = JSON.stringify({
    name: input.groupName,
    include,
    require: current.require,
    exclude: current.exclude,
  })
  await request(input, validated, 'PUT', payload)
  const verified = await request(input, validated, 'GET')
  if (!sameRules(verified.include, include)
    || !sameRules(verified.require, current.require)
    || !sameRules(verified.exclude, current.exclude)) {
    fail('ACCESS_PROVIDER_VERIFICATION_MISMATCH')
  }
  return Object.freeze({ reconciled: true })
}
