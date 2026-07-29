import { z } from 'zod'
import { decodeBase64Url, encodeBase64Url } from './security/encoding.js'

const BASE64_URL_KEY = /^[A-Za-z0-9_-]{43}$/
const VERSION = /^[1-9]\d*$/
const TEAM_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const key = z.string().refine((value) => {
  if (!BASE64_URL_KEY.test(value)) return false
  try {
    const decoded = decodeBase64Url(value)
    return decoded.byteLength === 32 && encodeBase64Url(decoded) === value
  } catch {
    return false
  }
}, 'must be a canonical base64url-encoded 32-byte key')

const version = z.string().refine((value) => {
  if (!VERSION.test(value)) return false
  return Number.isSafeInteger(Number(value))
}, 'must be a canonical positive safe integer')

const exactOrigin = (value) => {
  try {
    const url = new URL(value)
    return value === url.origin && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

const isDevelopmentOrigin = (value) => {
  if (!exactOrigin(value)) return false
  const url = new URL(value)
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

const isPublicHttpsOrigin = (value) => {
  if (!exactOrigin(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:'
    && (url.hostname === 'bearwithme.pl' || url.hostname.endsWith('.bearwithme.pl'))
}

const isAccessTeamDomain = (value) => {
  if (!exactOrigin(value)) return false
  const url = new URL(value)
  const suffix = '.cloudflareaccess.com'
  if (url.protocol !== 'https:' || !url.hostname.endsWith(suffix) || url.port) return false
  const label = url.hostname.slice(0, -suffix.length)
  return TEAM_LABEL.test(label)
}

const schema = z.object({
  APP_ENV: z.enum(['development', 'staging', 'production']),
  DATA_MODE: z.literal('fictional'),
  APP_ORIGIN: z.string(),
  ACCESS_AUD: z.string().trim().min(1),
  ACCESS_HEALTH_SERVICE_TOKEN_ID: z.string().trim().min(1),
  ACCESS_TEAM_DOMAIN: z.string().refine(isAccessTeamDomain, 'must be an exact Cloudflare Access team origin'),
  ACTIVE_DATA_KEK_VERSION: version,
  ACTIVE_LOOKUP_KEY_VERSION: version,
  ACTIVE_BACKUP_KEK_VERSION: version,
}).superRefine((value, context) => {
  const originIsValid = value.APP_ENV === 'development'
    ? isDevelopmentOrigin(value.APP_ORIGIN)
    : isPublicHttpsOrigin(value.APP_ORIGIN)
  if (!originIsValid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APP_ORIGIN'],
      message: 'must be an exact origin valid for APP_ENV',
    })
  }
})

export function loadConfig(env) {
  const value = schema.parse(env)
  const dataVersion = Number(value.ACTIVE_DATA_KEK_VERSION)
  const lookupVersion = Number(value.ACTIVE_LOOKUP_KEY_VERSION)
  const backupVersion = Number(value.ACTIVE_BACKUP_KEK_VERSION)
  key.parse(env[`BWM_DATA_KEK_V${dataVersion}`])
  key.parse(env[`BWM_LOOKUP_HMAC_V${lookupVersion}`])
  key.parse(env[`BWM_BACKUP_KEK_V${backupVersion}`])

  return {
    appEnv: value.APP_ENV,
    dataMode: value.DATA_MODE,
    appOrigin: value.APP_ORIGIN,
    accessAudience: value.ACCESS_AUD,
    accessHealthServiceTokenId: value.ACCESS_HEALTH_SERVICE_TOKEN_ID,
    accessIssuer: value.ACCESS_TEAM_DOMAIN,
    activeDataKekVersion: dataVersion,
    activeLookupKeyVersion: lookupVersion,
    activeBackupKekVersion: backupVersion,
    localAuth: value.APP_ENV === 'development',
  }
}
