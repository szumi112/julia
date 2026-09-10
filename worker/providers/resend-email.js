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

const BRAND = Object.freeze({
  paper: '#f8f5f0',
  surface: '#fdfbf8',
  line: '#ece5db',
  ink: '#2b1f4a',
  inkSoft: '#5b4f75',
  inkFaint: '#6d6188',
  pink: '#e88aac',
  coral: '#ed5a39',
  coralDeep: '#b03a1c',
  coralGhost: '#fce8e2',
  amber: '#ed9936',
  sky: '#b2d9ea',
  serif: "Georgia, 'Times New Roman', serif",
  sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
})
const LOGO = 'https://bearwithme.pl/wp-content/uploads/2024/03/logo_kolor_new.png'

const paragraph = (inner) => `<p style="margin:0 0 14px;font-family:${BRAND.sans};`
  + `font-size:15px;line-height:1.65;color:${BRAND.inkSoft};text-align:center;">${inner}</p>`

const codePanel = (code) => '<table role="presentation" width="100%" cellpadding="0" '
  + 'cellspacing="0" border="0" style="margin:2px 0 14px;"><tr><td align="center" '
  + `style="background:${BRAND.coralGhost};border-radius:12px;padding:22px 16px;">`
  + `<div style="font-family:${BRAND.serif};font-size:34px;font-weight:700;`
  + `letter-spacing:0.22em;color:${BRAND.ink};">${code}</div>`
  + '</td></tr></table>'

const actionButton = (href, label) => '<table role="presentation" cellpadding="0" '
  + 'cellspacing="0" border="0" align="center" style="margin:4px auto 18px;"><tr><td '
  + `align="center" style="background:${BRAND.coral};border-radius:10px;">`
  + `<a href="${href}" style="display:inline-block;padding:13px 26px;font-family:${BRAND.sans};`
  + 'font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">'
  + `${label}</a></td></tr></table>`

const metaRow = (label, value) => `<tr><td align="center" style="padding:6px 0;`
  + `font-family:${BRAND.sans};font-size:13px;line-height:1.5;color:${BRAND.inkFaint};">`
  + `<span style="color:${BRAND.ink};">${label}</span> ${value}</td></tr>`

const metaTable = (rows) => '<table role="presentation" width="100%" cellpadding="0" '
  + `cellspacing="0" border="0" style="border-top:1px solid ${BRAND.line};margin-top:6px;">`
  + `${rows.join('')}</table>`

const linkChip = (href) => '<table role="presentation" width="100%" cellpadding="0" '
  + 'cellspacing="0" border="0" style="margin:2px 0 6px;"><tr><td align="center" '
  + `style="background:${BRAND.paper};border:1px solid ${BRAND.line};border-radius:10px;`
  + 'padding:14px 18px;">'
  + `<a class="bwm-link" href="${href}" style="font-family:${BRAND.sans};font-size:13px;`
  + `line-height:1.6;color:${BRAND.ink};text-decoration:none;word-break:break-all;">`
  + `${href}</a></td></tr></table>`

const brandStripe = () => '<tr><td style="padding:0;"><table role="presentation" width="100%" '
  + 'cellpadding="0" cellspacing="0" border="0"><tr>'
  + [BRAND.pink, BRAND.coral, BRAND.amber, BRAND.sky].map((color) => (
    `<td width="25%" style="height:5px;background:${color};font-size:0;line-height:0;">&nbsp;</td>`
  )).join('')
  + '</tr></table></td></tr>'

const preheaderBlock = (text) => '<div style="display:none;max-height:0;overflow:hidden;'
  + `mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.paper};opacity:0;">`
  + `${text}</div>`

const logoHeader = () => `<tr><td align="center" style="background:${BRAND.ink};`
  + 'padding:30px 24px 26px;">'
  + `<img src="${LOGO}" width="132" alt="Bear with me" `
  + 'style="display:block;width:132px;max-width:132px;height:auto;border:0;'
  + `color:#ffffff;font-family:${BRAND.sans};font-size:15px;font-weight:700;"></td></tr>`

const darkFooter = (footnote) => `<tr><td align="center" style="background:${BRAND.ink};`
  + `padding:24px 32px 26px;font-family:${BRAND.sans};font-size:12px;line-height:1.6;`
  + 'color:#ccc3e2;text-align:center;">'
  + `<img src="${LOGO}" width="116" alt="Bear with me" `
  + 'style="display:block;margin:0 auto 12px;width:116px;max-width:116px;height:auto;border:0;'
  + `color:#ffffff;font-family:${BRAND.sans};font-size:14px;font-weight:700;">`
  + `${footnote}</td></tr>`

const paperFooter = (footnote) => `<tr><td align="center" style="background:${BRAND.paper};`
  + `padding:18px 32px 20px;border-top:1px solid ${BRAND.line};font-family:${BRAND.sans};`
  + `font-size:12px;line-height:1.6;color:${BRAND.inkFaint};text-align:center;">${footnote}</td></tr>`

function emailDocument({ title, heading, body, footnote, preheader = '', compact = false }) {
  return [
    '<!doctype html><html lang="pl"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light only">',
    `<title>${title}</title>`,
    `<style>.bwm-link:hover{text-decoration:underline !important;color:${BRAND.inkSoft} !important}`,
    '</style></head>',
    `<body style="margin:0;padding:0;background:${BRAND.paper};">`,
    preheader ? preheaderBlock(preheader) : '',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ',
    `style="background:${BRAND.paper};"><tr><td align="center" style="padding:32px 16px;">`,
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" ',
    `style="width:100%;max-width:600px;background:${BRAND.surface};`,
    `border:1px solid ${BRAND.line};border-radius:16px;overflow:hidden;">`,
    compact ? '' : logoHeader(),
    brandStripe(),
    `<tr><td align="center" style="padding:${compact ? '24px 32px 22px' : '32px 32px 28px'};">`,
    `<h1 style="margin:0 0 14px;font-family:${BRAND.serif};font-size:21px;font-weight:700;`,
    `line-height:1.3;color:${BRAND.ink};text-align:center;">${heading}</h1>`,
    body,
    '</td></tr>',
    compact ? darkFooter(footnote) : paperFooter(footnote),
    '</table></td></tr></table></body></html>',
  ].join('')
}

function invitationContent(appOrigin, expiresAt) {
  const moment = new Date(expiresAt)
  const expiryDate = new Intl.DateTimeFormat('pl-PL', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Warsaw',
  }).format(moment)
  const expiryTime = new Intl.DateTimeFormat('pl-PL', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw',
    timeZoneName: 'short', hour12: false,
  }).format(moment)
  const humanExpiry = `${expiryDate}, ${expiryTime}`
  const textOrigin = escapeInvitationText(appOrigin)
  const textHumanExpiry = escapeInvitationText(humanExpiry)
  const htmlOrigin = escapeInvitationHtml(appOrigin)
  const htmlHumanExpiry = escapeInvitationHtml(humanExpiry)
  return Object.freeze({
    subject: 'Zaproszenie do panelu Bear with me',
    text: [
      'Bear with me - Centrum Psychologiczno-Edukacyjne', '',
      'Otrzymujesz zaproszenie do panelu centrum.',
      `Panel: ${textOrigin}`,
      `Ważne do: ${textHumanExpiry}`,
    ].join('\n'),
    html: emailDocument({
      title: 'Zaproszenie do panelu Bear with me',
      heading: 'Zaproszenie do panelu centrum',
      body: [
        paragraph('Otrzymujesz dostęp do panelu Bear with me. Otwórz panel i dokończ '
          + 'zakładanie konta na swój adres e-mail.'),
        actionButton(htmlOrigin, 'Otwórz panel'),
        metaTable([
          metaRow('Adres panelu:', htmlOrigin),
          metaRow('Ważne do:', htmlHumanExpiry),
        ]),
      ].join(''),
      footnote: 'Zaproszenie jest jednorazowe i wygasa w podanym terminie. '
        + 'Jeśli nie spodziewasz się tej wiadomości, po prostu ją zignoruj.',
    }),
  })
}

function otpContent(otp) {
  const textOtp = escapeInvitationText(otp)
  const htmlOtp = escapeInvitationHtml(otp)
  return Object.freeze({
    subject: 'Kod logowania do Bear with me',
    text: `Kod logowania do panelu Bear with me: ${textOtp}. Kod jest ważny przez 5 minut.`,
    html: emailDocument({
      title: 'Kod logowania do Bear with me',
      heading: 'Twój kod logowania',
      preheader: `Kod logowania: ${htmlOtp} - ważny 5 minut, do jednorazowego użycia.`,
      compact: true,
      body: [
        codePanel(htmlOtp),
        paragraph('Wpisz ten kod w panelu Bear with me, aby dokończyć logowanie. '
          + 'Kod jest ważny przez 5 minut i można go użyć tylko raz.'),
      ].join(''),
      footnote: 'Nie przekazuj tego kodu nikomu. Jeśli to nie Ty próbujesz się zalogować, '
        + 'zignoruj tę wiadomość - bez kodu nikt nie wejdzie do panelu.',
    }),
  })
}

function resetContent(href) {
  const textHref = escapeInvitationText(href)
  const htmlHref = escapeInvitationHtml(href)
  return Object.freeze({
    subject: 'Zmiana hasła do Bear with me',
    text: `Aby ustawić nowe hasło do panelu Bear with me, otwórz: ${textHref}`,
    html: emailDocument({
      title: 'Zmiana hasła do Bear with me',
      heading: 'Zmiana hasła do panelu',
      body: [
        paragraph('Otrzymaliśmy prośbę o zmianę hasła do panelu Bear with me. '
          + 'Kliknij przycisk, aby ustawić nowe hasło.'),
        actionButton(htmlHref, 'Ustaw nowe hasło'),
        paragraph('Jeśli przycisk nie działa, skopiuj ten adres do przeglądarki:'),
        linkChip(htmlHref),
      ].join(''),
      footnote: 'Link jest jednorazowy i wkrótce wygaśnie. Jeśli to nie Ty prosiłaś o zmianę, '
        + 'zignoruj tę wiadomość - dotychczasowe hasło pozostaje aktywne.',
    }),
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
    || !acceptPhaseOneAccessEmail(input.recipient, { appEnv })) fail('EMAIL_PROVIDER_CONFIG_INVALID')
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
  if (!canonicalInstant(input.expiresAt)) fail('EMAIL_PROVIDER_CONFIG_INVALID')
  return sendEmail(input, invitationContent(input.appOrigin, input.expiresAt))
}

export async function sendAuthenticationEmail(input = {}) {
  validateInput(input)
  let content
  if (input.purpose === 'otp' && /^[0-9]{6}$/.test(input.otp ?? '')) {
    content = otpContent(input.otp)
  } else if (input.purpose === 'reset') {
    let url
    try { url = new URL(input.url) } catch { fail('EMAIL_PROVIDER_CONFIG_INVALID') }
    if (url.origin !== input.appOrigin || url.username || url.password
      || !url.pathname.startsWith('/api/auth/reset-password/')) fail('EMAIL_PROVIDER_CONFIG_INVALID')
    content = resetContent(url.href)
  } else {
    fail('EMAIL_PROVIDER_CONFIG_INVALID')
  }
  return sendEmail(input, content)
}

async function sendEmail(input, content) {
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
