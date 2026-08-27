import { z } from 'zod'
import { decodeBase64Url, encodeBase64Url } from './security/encoding.js'

const BASE64_URL_KEY = /^[A-Za-z0-9_-]{43}$/
const VERSION = /^[1-9]\d*$/
const TEAM_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PROVIDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ACCESS_ACCOUNT_ID = /^[0-9a-f]{32}$/
const ACCESS_GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BACKUP_ACCOUNT_ID = /^[0-9a-f]{32}$/
const BACKUP_DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BACKUP_KEK_PREFIX = 'BWM_BACKUP_KEK_V'
const BACKUP_TOKEN_PLACEHOLDERS = new Set([
  'change-me',
  'changeme',
  'example',
  'placeholder',
  'replace-me',
  'replaceme',
  'todo',
  'your-token-here',
])
const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength
const saneName = (value) => typeof value === 'string' && value === value.trim()
  && value.length > 0 && utf8Bytes(value) <= 120
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
const canonicalEmail = (value) => typeof value === 'string' && value === value.trim()
  && value === value.toLowerCase()
  && value === value.normalize('NFC')
  && utf8Bytes(value) <= 254
  && /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+$/u.test(value)
  && !value.startsWith('.') && !value.includes('..') && !value.includes('.@')

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

const PUBLIC_ORIGINS = Object.freeze({
  production: 'https://bearwithme-panel.app',
  staging: 'https://staging.bearwithme-panel.app',
})

const isPublicHttpsOrigin = (value, appEnv) => exactOrigin(value)
  && value === PUBLIC_ORIGINS[appEnv]

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
  ACTIVE_WORKBOOK_KEK_VERSION: version,
  ACTIVE_WORKBOOK_HMAC_VERSION: version,
}).superRefine((value, context) => {
  const originIsValid = value.APP_ENV === 'development'
    ? isDevelopmentOrigin(value.APP_ORIGIN)
    : isPublicHttpsOrigin(value.APP_ORIGIN, value.APP_ENV)
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
  const workbookKekVersion = Number(value.ACTIVE_WORKBOOK_KEK_VERSION)
  const workbookHmacVersion = Number(value.ACTIVE_WORKBOOK_HMAC_VERSION)
  key.parse(env[`BWM_DATA_KEK_V${dataVersion}`])
  key.parse(env[`BWM_LOOKUP_HMAC_V${lookupVersion}`])
  key.parse(env[`BWM_BACKUP_KEK_V${backupVersion}`])
  key.parse(env[`BWM_WORKBOOK_KEK_V${workbookKekVersion}`])
  key.parse(env[`BWM_WORKBOOK_HMAC_V${workbookHmacVersion}`])

  return Object.freeze({
    appEnv: value.APP_ENV,
    dataMode: value.DATA_MODE,
    appOrigin: value.APP_ORIGIN,
    accessAudience: value.ACCESS_AUD,
    accessHealthServiceTokenId: value.ACCESS_HEALTH_SERVICE_TOKEN_ID,
    accessIssuer: value.ACCESS_TEAM_DOMAIN,
    activeDataKekVersion: dataVersion,
    activeLookupKeyVersion: lookupVersion,
    activeBackupKekVersion: backupVersion,
    activeWorkbookKekVersion: workbookKekVersion,
    activeWorkbookHmacVersion: workbookHmacVersion,
    localAuth: value.APP_ENV === 'development',
  })
}

const strictConfigSnapshot = (config) => {
  if (config == null || typeof config !== 'object' || Object.getPrototypeOf(config) !== Object.prototype) throw new Error()
  const values = new Map()
  for (const name of Reflect.ownKeys(config)) {
    if (typeof name !== 'string') throw new Error()
    const descriptor = Object.getOwnPropertyDescriptor(config, name)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error()
    values.set(name, descriptor.value)
  }
  return values
}

const requiredEnvValues = (env, activeVersion) => {
  if (env == null || typeof env !== 'object') throw new Error()
  const names = Reflect.ownKeys(env)
  const stringNames = new Set()
  for (const name of names) {
    if (typeof name !== 'string') continue
    stringNames.add(name)
    if (name.startsWith(BACKUP_KEK_PREFIX)) {
      const suffix = name.slice(BACKUP_KEK_PREFIX.length)
      if (!VERSION.test(suffix) || !Number.isSafeInteger(Number(suffix))) throw new Error()
    }
  }

  const activeKeyName = `${BACKUP_KEK_PREFIX}${activeVersion}`
  const requiredNames = [
    'CF_ACCOUNT_ID',
    'CF_D1_DATABASE_ID',
    'CF_D1_EXPORT_TOKEN',
    'ARCHIVE',
    activeKeyName,
  ]
  const values = {}
  for (const name of requiredNames) {
    if (!stringNames.has(name)) throw new Error()
    const descriptor = Object.getOwnPropertyDescriptor(env, name)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error()
    values[name] = descriptor.value
  }
  return values
}

const hasArchiveCapability = (archive, name) => {
  for (const candidate of archive) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, name)
    if (descriptor) return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
  }
  return false
}

const archivePrototypeChain = (archive) => {
  const chain = []
  const seen = new Set()
  let current = archive
  while (current != null) {
    if (chain.length === 32 || seen.has(current)) return null
    seen.add(current)
    chain.push(current)
    current = Object.getPrototypeOf(current)
  }
  return chain
}

const isCanonicalBackupKey = (value) => {
  if (typeof value !== 'string' || !BASE64_URL_KEY.test(value)) return false
  let decoded
  try {
    decoded = decodeBase64Url(value)
    return decoded.byteLength === 32 && encodeBase64Url(decoded) === value
  } catch {
    return false
  } finally {
    decoded?.fill(0)
  }
}

const isBackupExportToken = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) return false
  return value === value.trim()
    && !/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    && utf8Bytes(value) <= 4096
    && !BACKUP_TOKEN_PLACEHOLDERS.has(value.replaceAll('_', '-').toLowerCase())
}

export function loadBackupProviderConfig(env, config) {
  const disabled = Symbol('backup provider disabled')
  try {
    const configValues = strictConfigSnapshot(config)
    const appEnv = configValues.get('appEnv')
    if (appEnv === 'development') throw disabled
    if (appEnv !== 'staging' && appEnv !== 'production') throw new Error()

    const activeVersion = configValues.get('activeBackupKekVersion')
    if (!Number.isSafeInteger(activeVersion) || activeVersion < 1) throw new Error()
    const values = requiredEnvValues(env, activeVersion)
    const accountId = values.CF_ACCOUNT_ID
    const databaseId = values.CF_D1_DATABASE_ID
    const token = values.CF_D1_EXPORT_TOKEN
    const archive = values.ARCHIVE
    const activeKey = values[`${BACKUP_KEK_PREFIX}${activeVersion}`]
    const archiveChain = archive != null && typeof archive === 'object'
      ? archivePrototypeChain(archive)
      : null
    const archiveCapabilities = archiveChain == null
      ? []
      : ['delete', 'get', 'list', 'put'].map((name) => hasArchiveCapability(archiveChain, name))

    if (typeof accountId !== 'string'
      || !BACKUP_ACCOUNT_ID.test(accountId) || accountId === '0'.repeat(32)
      || typeof databaseId !== 'string'
      || !BACKUP_DATABASE_ID.test(databaseId)
      || databaseId === '00000000-0000-0000-0000-000000000000'
      || databaseId === '00000000-0000-0000-0000-000000000001'
      || !isBackupExportToken(token)
      || !archiveCapabilities.every(Boolean)
      || !isCanonicalBackupKey(activeKey)) throw new Error()

    return Object.freeze({ accountId, databaseId, token })
  } catch (error) {
    throw new Error(error === disabled ? 'BACKUP_PROVIDER_DISABLED' : 'BACKUP_CONFIG_INVALID')
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
  return Object.freeze({ ...value, appEnv: config.appEnv })
}

export function loadEmailProviderConfig(env, config) {
  if (config?.appEnv === 'development') throw new Error('PROVIDER_DISABLED')
  if (!['staging', 'production'].includes(config?.appEnv)) throw new Error('PROVIDER_CONFIG_INVALID')
  const value = { projectId: env?.SCW_PROJECT_ID, fromEmail: env?.SCW_FROM_EMAIL, fromName: env?.SCW_FROM_NAME, secret: env?.SCW_SECRET_KEY }
  if (!PROVIDER_UUID.test(value.projectId ?? '')
    || !canonicalEmail(value.fromEmail)
    || !saneName(value.fromName)
    || typeof value.secret !== 'string'
    || value.secret.length < 1
    || /\s/u.test(value.secret)) throw new Error('PROVIDER_CONFIG_INVALID')
  return Object.freeze(value)
}
