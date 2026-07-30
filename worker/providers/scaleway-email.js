const ENDPOINT = 'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails'
const MAX_RESPONSE_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const MAX_JSON_DEPTH = 64
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const EMAIL = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+$/u
const OPTIONAL_STRINGS = Object.freeze([
  'message_id',
  'project_id',
  'mail_from',
  'mail_rcpt',
  'rcpt_type',
  'subject',
  'created_at',
  'updated_at',
  'status',
  'status_details',
  'rcpt_to',
])
const EMAIL_KEYS = new Set([
  'id',
  ...OPTIONAL_STRINGS,
  'try_count',
  'flags',
  'last_tries',
])
const providerErrors = new WeakSet()

const ownObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength
const uint32 = (value) => Number.isInteger(value) && value >= 0 && value <= 4_294_967_295
const int32 = (value) => Number.isInteger(value)
  && value >= -2_147_483_648 && value <= 2_147_483_647
const canonicalInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const canonicalEmail = (value) => typeof value === 'string'
  && value === value.trim()
  && value === value.toLowerCase()
  && value === value.normalize('NFC')
  && utf8Bytes(value) <= 254
  && EMAIL.test(value)
  && !value.startsWith('.')
  && !value.includes('..')
  && !value.includes('.@')
const saneName = (value) => typeof value === 'string'
  && value === value.trim()
  && value.length > 0
  && utf8Bytes(value) <= 120
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
const exactProtectedOrigin = (value) => {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return value === url.origin
      && url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (url.hostname === 'bearwithme.pl' || url.hostname.endsWith('.bearwithme.pl'))
  } catch {
    return false
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
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Warsaw',
    timeZoneName: 'short',
    hour12: false,
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
      'Bear with me - Centrum Psychologiczno-Edukacyjne',
      '',
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
  if (!ownObject(input)
    || typeof input.fetch !== 'function'
    || typeof input.secret !== 'string'
    || input.secret.length < 1
    || /\s/u.test(input.secret)
    || !UUID.test(input.projectId ?? '')
    || !canonicalEmail(input.fromEmail)
    || !saneName(input.fromName)
    || !exactProtectedOrigin(input.appOrigin)
    || !ID.test(input.jobId ?? '')
    || !canonicalEmail(input.recipient)
    || !input.recipient.endsWith('@example.test')
    || !canonicalInstant(input.expiresAt)) {
    fail('EMAIL_PROVIDER_CONFIG_INVALID')
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel()
  } catch {
    // Cancellation is best effort; provider error details stay private.
  }
}

async function readBoundedBody(response, signal) {
  const getReader = response?.body?.getReader
  if (typeof getReader !== 'function') throw new Error('invalid_body')
  let reader
  try {
    reader = getReader.call(response.body)
  } catch {
    throw new Error('invalid_body')
  }
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
      try {
        part = await reader.read()
      } catch {
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
    try {
      reader.releaseLock?.()
    } catch {
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
  const whitespace = () => {
    while (/[\t\n\r ]/.test(text[index] ?? '')) index += 1
  }
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
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
            throw new Error('invalid_json')
          }
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
      if (text[index] === ']') {
        index += 1
        return result
      }
      while (true) {
        result.push(value(depth + 1))
        whitespace()
        if (text[index] === ']') {
          index += 1
          return result
        }
        if (text[index] !== ',') throw new Error('invalid_json')
        index += 1
      }
    }
    if (text[index] === '{') {
      index += 1
      whitespace()
      const result = {}
      const keys = new Set()
      if (text[index] === '}') {
        index += 1
        return result
      }
      while (true) {
        whitespace()
        const key = string()
        if (keys.has(key)) throw new Error('duplicate_key')
        keys.add(key)
        whitespace()
        if (text[index] !== ':') throw new Error('invalid_json')
        index += 1
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: value(depth + 1),
          writable: true,
        })
        whitespace()
        if (text[index] === '}') {
          index += 1
          return result
        }
        if (text[index] !== ',') throw new Error('invalid_json')
        index += 1
      }
    }
    for (const [literal, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (text.startsWith(literal, index)) {
        index += literal.length
        return result
      }
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
  if (!exactKeys(parsed, ['emails']) || !Array.isArray(parsed.emails)
    || parsed.emails.length !== 1 || !ownObject(parsed.emails[0])) {
    throw new Error('invalid_response')
  }
  const email = parsed.emails[0]
  const keys = Object.keys(email)
  if (!Object.hasOwn(email, 'id')
    || keys.some((key) => !EMAIL_KEYS.has(key))
    || !UUID.test(email.id ?? '')) throw new Error('invalid_response')
  for (const key of OPTIONAL_STRINGS) {
    if (Object.hasOwn(email, key) && typeof email[key] !== 'string') {
      throw new Error('invalid_response')
    }
  }
  if (Object.hasOwn(email, 'try_count') && !uint32(email.try_count)) {
    throw new Error('invalid_response')
  }
  if (Object.hasOwn(email, 'flags')
    && (!Array.isArray(email.flags) || !email.flags.every((flag) => typeof flag === 'string'))) {
    throw new Error('invalid_response')
  }
  if (Object.hasOwn(email, 'last_tries')) {
    if (!Array.isArray(email.last_tries)) throw new Error('invalid_response')
    for (const attempt of email.last_tries) {
      if (!exactKeys(attempt, ['rank', 'tried_at', 'code', 'message'])
        || !uint32(attempt.rank)
        || typeof attempt.tried_at !== 'string'
        || !int32(attempt.code)
        || typeof attempt.message !== 'string') throw new Error('invalid_response')
    }
  }
  return email.id
}

async function sendAndValidate(input, request, signal) {
  const response = await input.fetch(ENDPOINT, { ...request, signal })
  if (!response || !Number.isInteger(response.status)
    || response.status < 100 || response.status > 599) throw new Error('invalid_response')
  if (response.status !== 200) {
    try {
      Promise.resolve(response.body?.cancel?.()).catch(() => {})
    } catch {
      // Non-200 body cancellation is best effort and never changes classification.
    }
  }
  if (response.status === 429) fail('EMAIL_PROVIDER_RATE_LIMITED', true, false)
  if (response.status >= 400 && response.status <= 499) {
    fail('EMAIL_PROVIDER_REJECTED', false, false)
  }
  if (response.status !== 200) throw new Error('ambiguous_response')
  const raw = await readBoundedBody(response, signal)
  const parsed = parseJsonWithoutDuplicateKeys(raw)
  return { providerId: validatedProviderId(parsed) }
}

export async function sendInvitationEmail(input = {}) {
  validateInput(input)
  const content = invitationContent(input.appOrigin, input.expiresAt)
  const body = {
    project_id: input.projectId,
    from: { email: input.fromEmail, name: input.fromName },
    to: [{ email: input.recipient }],
    subject: content.subject,
    text: content.text,
    html: content.html,
    additional_headers: [{ key: 'X-BWM-Job-ID', value: input.jobId }],
  }
  const request = {
    method: 'POST',
    headers: {
      'X-Auth-Token': input.secret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
