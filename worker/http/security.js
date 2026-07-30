const MAX_BODY_BYTES = 65_536
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const SUPPORTED = new Set(['GET', 'HEAD', 'OPTIONS', ...MUTATIONS])
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i
const CORS_PERMISSION_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
  'access-control-expose-headers',
]

const fail = (code) => { throw new Error(code) }
const skipWhitespace = (text, start) => {
  let index = start
  while (index < text.length && (
    text[index] === ' '
    || text[index] === '\n'
    || text[index] === '\r'
    || text[index] === '\t'
  )) index += 1
  return index
}
const hexValue = (character) => {
  const code = character.charCodeAt(0)
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 65 && code <= 70) return code - 55
  if (code >= 97 && code <= 102) return code - 87
  return -1
}

function jsonStringAt(text, start, decode) {
  if (text[start] !== '"') fail('INVALID_JSON')
  let index = start + 1
  let value = ''
  while (index < text.length) {
    const character = text[index]
    if (character === '"') return { end: index + 1, value }
    if (character !== '\\') {
      if (decode) value += character
      index += 1
      continue
    }
    const escaped = text[index + 1]
    if (escaped === undefined) fail('INVALID_JSON')
    if (escaped === 'u') {
      let code = 0
      for (let offset = 0; offset < 4; offset += 1) {
        const part = hexValue(text[index + 2 + offset] ?? '')
        if (part < 0) fail('INVALID_JSON')
        code = (code * 16) + part
      }
      if (decode) value += String.fromCharCode(code)
      index += 6
      continue
    }
    const decoded = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    }[escaped]
    if (decoded === undefined) fail('INVALID_JSON')
    if (decode) value += decoded
    index += 2
  }
  fail('INVALID_JSON')
}

export function hasDuplicateTopLevelJsonKey(text) {
  if (typeof text !== 'string') fail('INVALID_JSON')
  let index = skipWhitespace(text, 0)
  if (text[index] !== '{') return false
  index = skipWhitespace(text, index + 1)
  if (text[index] === '}') return false
  const keys = new Set()
  for (;;) {
    const key = jsonStringAt(text, index, true)
    if (keys.has(key.value)) return true
    keys.add(key.value)
    index = skipWhitespace(text, key.end)
    if (text[index] !== ':') fail('INVALID_JSON')
    index = skipWhitespace(text, index + 1)
    let depth = 0
    for (;;) {
      const character = text[index]
      if (character === undefined) fail('INVALID_JSON')
      if (character === '"') {
        index = jsonStringAt(text, index, false).end
        continue
      }
      if (character === '{' || character === '[') depth += 1
      else if (character === ']' && depth > 0) depth -= 1
      else if (character === '}' && depth > 0) depth -= 1
      else if (character === '}' && depth === 0) return false
      else if (character === ',' && depth === 0) {
        index = skipWhitespace(text, index + 1)
        break
      }
      index += 1
    }
  }
}

export function parseCanonicalContentLength(value, { maxBytes = MAX_BODY_BYTES } = {}) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) fail('INVALID_CONTENT_LENGTH')
  const length = Number(value)
  if (!Number.isSafeInteger(length)) fail('INVALID_CONTENT_LENGTH')
  if (length > maxBytes) fail('PAYLOAD_TOO_LARGE')
  return length
}

export function isMutationMethod(method) {
  return MUTATIONS.has(method)
}

export function isSupportedMethod(method) {
  return SUPPORTED.has(method)
}

export function validateMutationMetadata(request, config) {
  if (request.headers.get('Origin') !== config?.appOrigin) fail('ORIGIN_INVALID')
  const fetchSite = request.headers.get('Sec-Fetch-Site')
  if (fetchSite !== null && fetchSite.toLowerCase() !== 'same-origin') fail('FETCH_METADATA_INVALID')
  const contentType = request.headers.get('Content-Type')
  if (contentType === null || !JSON_TYPE.test(contentType) || contentType.includes(',')) fail('UNSUPPORTED_MEDIA_TYPE')
  if (request.headers.has('Content-Encoding')) fail('UNSUPPORTED_MEDIA_TYPE')
  parseCanonicalContentLength(request.headers.get('Content-Length'))
}

export function validateOptionsOrigin(request, config) {
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== config?.appOrigin) fail('ORIGIN_INVALID')
}

export async function readJsonBodyOnce(request, {
  maxBytes = MAX_BODY_BYTES,
  rejectDuplicateTopLevelKeys = false,
} = {}) {
  if (!(request instanceof Request) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('INVALID_JSON')
  const reader = request.body?.getReader()
  if (!reader) fail('INVALID_JSON')
  const chunks = []
  let total = 0
  let joined
  try {
    for (;;) {
      let part
      try {
        part = await reader.read()
      } catch {
        fail('INVALID_JSON')
      }
      if (part.done) break
      if (!(part.value instanceof Uint8Array)) fail('INVALID_JSON')
      total += part.value.byteLength
      if (total > maxBytes) {
        part.value.fill(0)
        try { await reader.cancel() } catch { /* The public error is size-only. */ }
        fail('PAYLOAD_TOO_LARGE')
      }
      const copy = part.value.slice()
      part.value.fill(0)
      chunks.push(copy)
    }
    joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(joined)
    } catch {
      fail('INVALID_JSON')
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      fail('INVALID_JSON')
    }
    if (rejectDuplicateTopLevelKeys && hasDuplicateTopLevelJsonKey(text)) {
      fail('VALIDATION_FAILED')
    }
    return parsed
  } finally {
    for (const chunk of chunks) chunk.fill(0)
    joined?.fill(0)
    try { reader.releaseLock() } catch { /* The stream remains consumed. */ }
  }
}

export function applyApiSecurityHeaders(response, correlationId) {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('Content-Security-Policy', "default-src 'none'")
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Correlation-ID', correlationId)
  for (const header of CORS_PERMISSION_HEADERS) headers.delete(header)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
