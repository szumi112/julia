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

export async function readJsonBodyOnce(request, { maxBytes = MAX_BODY_BYTES } = {}) {
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
      return JSON.parse(text)
    } catch {
      fail('INVALID_JSON')
    }
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
