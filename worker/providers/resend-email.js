import {
  acceptCanonicalEmail,
  acceptPhaseOneAccessEmail,
} from '../identity/canonical-email.js'

const ENDPOINT = 'https://api.resend.com/emails'
const MAX_RESPONSE_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const MAX_JSON_DEPTH = 64
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const PROTECTED_ORIGINS = new Map([
  ['https://bearwithme-panel.app', 'production'],
  ['https://staging.bearwithme-panel.app', 'staging'],
])
const providerErrors = new WeakSet()

const ownObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength
const canonicalInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const saneName = (value) => typeof value === 'string'
  && value === value.trim()
  && value.length > 0
  && utf8Bytes(value) <= 120
  && !/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
const protectedEnvironment = (value) => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    const valid = value === url.origin
      && url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
    return valid ? (PROTECTED_ORIGINS.get(value) ?? null) : null
  } catch {
    return null
  }
}

function providerError(code, retryable = false, ambiguous = false) {
  const error = Object.assign(new Error(code), { code, retryable, ambiguous })
  providerErrors.add(error)
  return error
}

const fail = (code, retryable = false, ambiguous = false) => {
  throw providerError(code, retryable, ambiguous)
}

const isProviderError = (value) => (typeof value === 'object' && value !== null)
  || typeof value === 'function'
  ? providerErrors.has(value)
  : false

export function escapeInvitationText(value) {
  if (typeof value !== 'string') fail('EMAIL_PROVIDER_CONFIG_INVALID')
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
}

export function escapeInvitationHtml(value) {
  return escapeInvitationText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;')
}

function invitationContent(appOrigin, expiresAt) {
  const humanExpiry = new Intl.DateTimeFormat('pl-PL', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
    second: '2-digit', timeZone: 'Europe/Warsaw', timeZoneName: 'short', hour12: false,
  }).format(new Date(expiresAt))
  const textOrigin = escapeInvitationText(appOrigin)
  const textExpiry = escapeInvitationText(expiresAt)
  const textHumanExpiry = escapeInvitationText(humanExpiry)
  const htmlOrigin = escapeInvitationHtml(appOrigin)
  const htmlExpiry = escapeInvitationHtml(expiresAt)
  const htmlHumanExpiry = escapeInvitationHtml(humanExpiry)
  return Object.freeze({
    subject: 'Zaproszenie do panelu Bear with me',
    text: [
      'Bear with me - Centrum Psychologiczno-Edukacyjne', '',
      'Otrzymujesz zaproszenie do panelu centrum.',
      `Panel: ${textOrigin}`,
      `Ważne do (ISO UTC): ${textExpiry}`,
      `Ważne do (Europe/Warsaw): ${textHumanExpiry}`,
    ].join('\n'),
    html: [
      '<p><strong>Bear with me - Centrum Psychologiczno-Edukacyjne</strong></p>',
      '<p>Otrzymujesz zaproszenie do panelu centrum.</p>',
      `<p><a href="${htmlOrigin}">Otwórz panel</a></p>`,
      `<p>Ważne do (ISO UTC): ${htmlExpiry}<br>`,
      `Ważne do (Europe/Warsaw): ${htmlHumanExpiry}</p>`,
    ].join(''),
  })
}

function validateInput(input) {
  const appEnv = protectedEnvironment(input?.appOrigin)
  if (!ownObject(input)
    || typeof input.fetch !== 'function'
    || typeof input.apiKey !== 'string'
    || input.apiKey.length < 1
    || /\s/u.test(input.apiKey)
    || !acceptCanonicalEmail(input.fromEmail)
    || !saneName(input.fromName)
    || appEnv === null
    || !ID.test(input.jobId ?? '')
    || !acceptPhaseOneAccessEmail(input.recipient, { appEnv })
    || !canonicalInstant(input.expiresAt)) fail('EMAIL_PROVIDER_CONFIG_INVALID')
}

async function cancelReader(reader) {
  try { await reader.cancel() } catch {
    // Cancellation is best effort; provider error details stay private.
  }
}

async function readBoundedBody(response, signal) {
  const getReader = response?.body?.getReader
  if (typeof getReader !== 'function') throw new Error('invalid_body')
  let reader
  try { reader = getReader.call(response.body) } catch { throw new Error('invalid_body') }
  if (!reader || typeof reader.read !== 'function' || typeof reader.cancel !== 'function') {
    throw new Error('invalid_body')
  }
  const chunks = []
  let length = 0
  let cancelled = false
  const cancel = async () => {
    if (cancelled) return
    cancelled = true
    await cancelReader(reader)
  }
  const abort = () => { void cancel() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) {
      await cancel()
      throw new Error('invalid_body')
    }
    while (true) {
      let part
      try { part = await reader.read() } catch {
        await cancel()
        throw new Error('invalid_body')
      }
      if (!exactKeys(part, ['value', 'done']) || typeof part.done !== 'boolean') {
        await cancel()
        throw new Error('invalid_body')
      }
      if (part.done) break
      if (!(part.value instanceof Uint8Array)) {
        await cancel()
        throw new Error('invalid_body')
      }
      length += part.value.byteLength
      if (length > MAX_RESPONSE_BYTES) {
        await cancel()
        throw new Error('invalid_body')
      }
      chunks.push(part.value.slice())
    }
  } finally {
    signal.removeEventListener('abort', abort)
    try { reader.releaseLock?.() } catch {
      // A release failure does not change the fixed provider classification.
    }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
    chunk.fill(0)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally {
    bytes.fill(0)
  }
}

function parseJsonWithoutDuplicateKeys(text) {
  let index = 0
  const whitespace = () => { while (/[\t\n\r ]/.test(text[index] ?? '')) index += 1 }
  const string = () => {
    const start = index
    if (text[index] !== '"') throw new Error('invalid_json')
    index += 1
    while (index < text.length) {
      const character = text[index]
      if (character === '"') {
        index += 1
        return JSON.parse(text.slice(start, index))
      }
      if (character === '\\') {
        index += 1
        if (index >= text.length) throw new Error('invalid_json')
        if (text[index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) throw new Error('invalid_json')
          index += 5
        } else {
          if (!/["\\/bfnrt]/.test(text[index])) throw new Error('invalid_json')
          index += 1
        }
        continue
      }
      if (character.charCodeAt(0) <= 0x1f) throw new Error('invalid_json')
      index += 1
    }
    throw new Error('invalid_json')
  }
  const value = (depth = 0) => {
    if (depth > MAX_JSON_DEPTH) throw new Error('invalid_json')
    whitespace()
    if (text[index] === '"') return string()
    if (text[index] === '[') {
      index += 1
      whitespace()
      const result = []
      if (text[index] === ']') { index += 1; return result }
      while (true) {
        result.push(value(depth + 1))
        whitespace()
        if (text[index] === ']') { index += 1; return result }
        if (text[index] !== ',') throw new Error('invalid_json')
        index += 1
      }
    }
    if (text[index] === '{') {
      index += 1
      whitespace()
      const result = {}
      const keys = new Set()
      if (text[index] === '}') { index += 1; return result }
      while (true) {
        whitespace()
        const key = string()
        if (keys.has(key)) throw new Error('duplicate_key')
        keys.add(key)
        whitespace()
        if (text[index] !== ':') throw new Error('invalid_json')
        index += 1
        Object.defineProperty(result, key, {
          configurable: true, enumerable: true, value: value(depth + 1), writable: true,
        })
        whitespace()
        if (text[index] === '}') { index += 1; return result }
        if (text[index] !== ',') throw new Error('invalid_json')
        index += 1
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, index)) { index += literal.length; return result }
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (!number) throw new Error('invalid_json')
    index += number[0].length
    const result = Number(number[0])
    if (!Number.isFinite(result)) throw new Error('invalid_json')
    return result
  }
  const result = value()
  whitespace()
  if (index !== text.length) throw new Error('invalid_json')
  return result
}

function validatedProviderId(parsed) {
  if (!exactKeys(parsed, ['id']) || !UUID.test(parsed.id ?? '')) throw new Error('invalid_response')
  return parsed.id
}

async function sendAndValidate(input, request, signal) {
  const fetchImpl = input.fetch
  const response = await fetchImpl(ENDPOINT, { ...request, signal })
  if (!response
    || response.redirected !== false
    || response.url !== ENDPOINT
    || !Number.isInteger(response.status)
    || response.status < 100 || response.status > 599) throw new Error('invalid_response')
  if (response.status !== 200) {
    try { Promise.resolve(response.body?.cancel?.()).catch(() => {}) } catch {
      // Non-200 body cancellation is best effort and never changes classification.
    }
  }
  if (response.status === 429) fail('EMAIL_PROVIDER_RATE_LIMITED', true, false)
  if (response.status >= 400 && response.status <= 499) fail('EMAIL_PROVIDER_REJECTED', false, false)
  if (response.status !== 200) throw new Error('ambiguous_response')
  const raw = await readBoundedBody(response, signal)
  return { providerId: validatedProviderId(parseJsonWithoutDuplicateKeys(raw)) }
}

export async function sendInvitationEmail(input = {}) {
  validateInput(input)
  const content = invitationContent(input.appOrigin, input.expiresAt)
  const body = {
    from: `${input.fromName} <${input.fromEmail}>`,
    to: [input.recipient],
    subject: content.subject,
    text: content.text,
    html: content.html,
    headers: { 'X-BWM-Job-ID': input.jobId },
  }
  const request = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': input.jobId,
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  }
  const controller = new AbortController()
  let timeout
  try {
    return await Promise.race([
      sendAndValidate(input, request, controller.signal),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error('timeout'))
        }, REQUEST_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    if (isProviderError(error)) throw error
    fail('EMAIL_DELIVERY_AMBIGUOUS', false, true)
  } finally {
    clearTimeout(timeout)
  }
}
