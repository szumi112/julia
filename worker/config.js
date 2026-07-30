import { z } from 'zod'
import { decodeBase64Url, encodeBase64Url } from './security/encoding.js'

const BASE64_URL_KEY = /^[A-Za-z0-9_-]{43}$/
const VERSION = /^[1-9]\d*$/
const TEAM_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const ACCESS_ACCOUNT_ID = /^[0-9a-f]{32}$/
const ACCESS_GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const saneName = (value) => typeof value === 'string' && value === value.trim()
  && value.length > 0 && new TextEncoder().encode(value).byteLength <= 120
  && !/[\u0000-\u001f\u007f]/.test(value)
const canonicalEmail = (value) => typeof value === 'string' && value === value.trim()
  && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && value.length <= 254

const key = z.string().refine((value) => {
  if (!BASE64_URL_KEY.test(value)) return false
  let decoded
  try {
    decoded = decodeBase64Url(value)
    return decoded.byteLength === 32 && encodeBase64Url(decoded) === value
  } catch {
    return false
  } finally {
    decoded?.fill(0)
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

export function loadAccessProviderConfig(env, config) {
  if (config?.appEnv === 'development') throw new Error('PROVIDER_DISABLED')
  if (!['staging', 'production'].includes(config?.appEnv)) throw new Error('PROVIDER_CONFIG_INVALID')
  const value = { accountId: env?.CF_ACCOUNT_ID, groupId: env?.CF_ACCESS_GROUP_ID, groupName: env?.CF_ACCESS_GROUP_NAME, token: env?.CF_ACCESS_GROUP_TOKEN }
  if (!ACCESS_ACCOUNT_ID.test(value.accountId ?? '')
    || !ACCESS_GROUP_ID.test(value.groupId ?? '')
    || !saneName(value.groupName)
    || typeof value.token !== 'string'
    || value.token.length < 1
    || value.token.length > 4096
    || /\s/u.test(value.token)) throw new Error('PROVIDER_CONFIG_INVALID')
  return Object.freeze(value)
}

export function loadEmailProviderConfig(env, config) {
  if (config?.appEnv === 'development') throw new Error('PROVIDER_DISABLED')
  const value = { projectId: env?.SCW_PROJECT_ID, fromEmail: env?.SCW_FROM_EMAIL, fromName: env?.SCW_FROM_NAME, secret: env?.SCW_SECRET_KEY }
  if (!PROVIDER_ID.test(value.projectId ?? '') || !canonicalEmail(value.fromEmail) || !saneName(value.fromName) || typeof value.secret !== 'string' || !value.secret.trim()) throw new Error('PROVIDER_CONFIG_INVALID')
  return Object.freeze(value)
}
