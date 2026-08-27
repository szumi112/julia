import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfig } from '../worker/config.js'

const USAGE = 'Usage: node scripts/configure-cloudflare-env.mjs <provider-results.json> [--wrangler <path>]'
const DEFAULT_WRANGLER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../wrangler.json')
const ENVIRONMENT_NAMES = ['staging', 'production']
const ENVIRONMENT_FIELDS = [
  'accountId',
  'appOrigin',
  'd1',
  'r2',
  'accessAudience',
  'accessGroupId',
  'accessGroupName',
  'accessHealthServiceTokenId',
  'accessTeamDomain',
]
const ACCOUNT_ID = /^[0-9a-f]{32}$/
const PROVIDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ZEROED_DATABASE_ID = /^0{8}-0{4}-0{4}-0{4}-0{11}[0-9a-f]$/
// Replicated from worker/config.js isAccessTeamDomain for pointed per-field errors;
// the imported loadConfig additionally validates every emitted env end-to-end.
const TEAM_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4_HOSTNAME = /^\d{1,3}(?:\.\d{1,3}){3}$/
const SENDER_EMAIL = /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const LOCAL_ACCESS_PLACEHOLDERS = new Set(['local-access-audience', 'local-health-service'])
const LOCAL_TEAM_DOMAIN = 'https://local.cloudflareaccess.com'
const FORBIDDEN_ORIGIN_SUFFIXES = ['.test', '.local', '.localhost', '.cloudflareaccess.com']
const REQUIRED_SECRETS = [
  'BWM_BACKUP_KEK_V1',
  'BWM_DATA_KEK_V1',
  'BWM_LOOKUP_HMAC_V1',
  'BWM_WORKBOOK_HMAC_V1',
  'BWM_WORKBOOK_KEK_V1',
  'CF_ACCESS_GROUP_TOKEN',
  'CF_D1_EXPORT_TOKEN',
  'SCW_SECRET_KEY',
]
// Canonical base64url encoding of 32 zero bytes: a shape-valid stand-in so the
// runtime schema can validate emitted vars without any real key material.
const DUMMY_SECRET_KEY = 'A'.repeat(43)
// Required per environment by the worker/config.js schema; wrangler env vars are
// non-inheritable, so the top-level values are copied into each environment.
const INHERITED_VAR_NAMES = [
  'ACTIVE_DATA_KEK_VERSION',
  'ACTIVE_LOOKUP_KEY_VERSION',
  'ACTIVE_BACKUP_KEK_VERSION',
  'ACTIVE_WORKBOOK_KEK_VERSION',
  'ACTIVE_WORKBOOK_HMAC_VERSION',
]
// Environment-specific identifiers that staging and production must never share.
const DISTINCT_FIELDS = [
  ['d1.id', (section) => section.d1.id],
  ['d1.name', (section) => section.d1.name],
  ['r2.name', (section) => section.r2.name],
  ['appOrigin', (section) => section.appOrigin],
  ['accessAudience', (section) => section.accessAudience],
  ['accessGroupId', (section) => section.accessGroupId],
  ['accessHealthServiceTokenId', (section) => section.accessHealthServiceTokenId],
]

const fail = (message) => {
  throw new Error(message)
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const trimmedNonEmpty = (value) => typeof value === 'string' && value.length > 0 && value === value.trim()

const requireExactFields = (section, path, required, optional = []) => {
  if (!isPlainObject(section)) fail(`${path} must be an object`)
  for (const field of required) {
    if (!Object.hasOwn(section, field)) fail(`${path}.${field} is required`)
  }
  const allowed = new Set([...required, ...optional])
  for (const field of Object.keys(section)) {
    if (!allowed.has(field)) fail(`${path}.${field} is not a recognized field`)
  }
}

const exactOrigin = (value) => {
  try {
    const url = new URL(value)
    return value === url.origin && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

const isPublicCustomOrigin = (value) => {
  if (typeof value !== 'string' || !exactOrigin(value)) return false
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.port !== '') return false
  const hostname = url.hostname
  if (hostname === 'localhost' || hostname.startsWith('[') || IPV4_HOSTNAME.test(hostname)) return false
  return !FORBIDDEN_ORIGIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
}

const isAccessTeamDomain = (value) => {
  if (typeof value !== 'string' || !exactOrigin(value)) return false
  const url = new URL(value)
  const suffix = '.cloudflareaccess.com'
  if (url.protocol !== 'https:' || !url.hostname.endsWith(suffix) || url.port) return false
  return TEAM_LABEL.test(url.hostname.slice(0, -suffix.length))
}

const localPlaceholders = (config) => {
  const databaseIds = new Set()
  const resourceNames = new Set()
  for (const database of Array.isArray(config.d1_databases) ? config.d1_databases : []) {
    if (typeof database?.database_id === 'string') databaseIds.add(database.database_id)
    if (typeof database?.database_name === 'string') resourceNames.add(database.database_name)
    if (typeof database?.preview_database_id === 'string') resourceNames.add(database.preview_database_id)
  }
  for (const bucket of Array.isArray(config.r2_buckets) ? config.r2_buckets : []) {
    if (typeof bucket?.bucket_name === 'string') resourceNames.add(bucket.bucket_name)
  }
  return { databaseIds, resourceNames }
}

const inheritedVersionVars = (config) => {
  if (!isPlainObject(config)) fail('wrangler config must be a JSON object')
  if (!isPlainObject(config.vars)) fail('wrangler config vars must be an object')
  const values = {}
  for (const name of INHERITED_VAR_NAMES) {
    const value = config.vars[name]
    if (typeof value !== 'string' || value.length === 0) {
      fail(`wrangler config vars.${name} must be a non-empty string; it is copied into every environment`)
    }
    values[name] = value
  }
  return values
}

const validateScalewaySection = (path, scaleway) => {
  requireExactFields(scaleway, path, ['projectId', 'fromEmail', 'fromName'])
  if (typeof scaleway.projectId !== 'string' || !PROVIDER_UUID.test(scaleway.projectId)) {
    fail(`${path}.projectId must be a lowercase UUID`)
  }
  if (typeof scaleway.fromEmail !== 'string' || !SENDER_EMAIL.test(scaleway.fromEmail) || scaleway.fromEmail.includes('..')) {
    fail(`${path}.fromEmail must be a lowercase public sender email address`)
  }
  if (!trimmedNonEmpty(scaleway.fromName)) fail(`${path}.fromName must be a non-empty trimmed string`)
}

const validateEnvironmentSection = (name, section, local) => {
  requireExactFields(section, name, ENVIRONMENT_FIELDS, ['scaleway'])
  if (typeof section.accountId !== 'string' || !ACCOUNT_ID.test(section.accountId)) {
    fail(`${name}.accountId must be exactly 32 lowercase hex characters`)
  }

  requireExactFields(section.d1, `${name}.d1`, ['id', 'name', 'jurisdiction'])
  if (typeof section.d1.id !== 'string' || !PROVIDER_UUID.test(section.d1.id)) {
    fail(`${name}.d1.id must be a lowercase UUID`)
  }
  if (ZEROED_DATABASE_ID.test(section.d1.id)) fail(`${name}.d1.id must not be a zeroed placeholder identifier`)
  if (local.databaseIds.has(section.d1.id)) fail(`${name}.d1.id must differ from the local placeholder database id`)
  if (section.d1.jurisdiction !== 'eu') fail(`${name}.d1.jurisdiction must be exactly "eu"`)
  if (!trimmedNonEmpty(section.d1.name)) fail(`${name}.d1.name must be a non-empty trimmed string`)
  if (local.resourceNames.has(section.d1.name)) fail(`${name}.d1.name must differ from the local resource name`)

  requireExactFields(section.r2, `${name}.r2`, ['name', 'jurisdiction'])
  if (section.r2.jurisdiction !== 'eu') fail(`${name}.r2.jurisdiction must be exactly "eu"`)
  if (!trimmedNonEmpty(section.r2.name)) fail(`${name}.r2.name must be a non-empty trimmed string`)
  if (local.resourceNames.has(section.r2.name)) fail(`${name}.r2.name must differ from the local resource name`)

  if (!isPublicCustomOrigin(section.appOrigin)) {
    fail(`${name}.appOrigin must be an exact https origin with a public hostname (no path, search, hash, credentials, port, IP, localhost, or .test/.local/.localhost/.cloudflareaccess.com suffix)`)
  }
  if (!isAccessTeamDomain(section.accessTeamDomain)) {
    fail(`${name}.accessTeamDomain must be an exact https://<team>.cloudflareaccess.com origin`)
  }
  if (section.accessTeamDomain === LOCAL_TEAM_DOMAIN) {
    fail(`${name}.accessTeamDomain must not be the local placeholder team domain`)
  }

  for (const field of ['accessAudience', 'accessHealthServiceTokenId', 'accessGroupName']) {
    if (!trimmedNonEmpty(section[field])) fail(`${name}.${field} must be a non-empty trimmed string`)
  }
  for (const field of ['accessAudience', 'accessHealthServiceTokenId']) {
    if (LOCAL_ACCESS_PLACEHOLDERS.has(section[field])) fail(`${name}.${field} must not be a local placeholder value`)
  }
  if (typeof section.accessGroupId !== 'string' || !PROVIDER_UUID.test(section.accessGroupId)) {
    fail(`${name}.accessGroupId must be a lowercase UUID`)
  }

  if (Object.hasOwn(section, 'scaleway')) validateScalewaySection(`${name}.scaleway`, section.scaleway)
}

const buildEnvironmentBlock = (name, section, inheritedVars) => {
  const vars = {
    APP_ENV: name,
    APP_ORIGIN: section.appOrigin,
    DATA_MODE: 'fictional',
    ACCESS_AUD: section.accessAudience,
    ACCESS_HEALTH_SERVICE_TOKEN_ID: section.accessHealthServiceTokenId,
    ACCESS_TEAM_DOMAIN: section.accessTeamDomain,
    ...inheritedVars,
    CF_ACCOUNT_ID: section.accountId,
    CF_D1_DATABASE_ID: section.d1.id,
    CF_ACCESS_GROUP_ID: section.accessGroupId,
    CF_ACCESS_GROUP_NAME: section.accessGroupName,
  }
  if (section.scaleway) {
    vars.SCW_PROJECT_ID = section.scaleway.projectId
    vars.SCW_FROM_EMAIL = section.scaleway.fromEmail
    vars.SCW_FROM_NAME = section.scaleway.fromName
  }
  // No per-env triggers: both top-level crons are inherited deliberately, because
  // worker/index.js requires exactly the minute and five-minute patterns.
  return {
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: new URL(section.appOrigin).hostname, custom_domain: true }],
    vars,
    // Wrangler does not inherit the top-level secrets manifest per environment,
    // so each env block repeats the required list.
    secrets: { required: [...REQUIRED_SECRETS] },
    d1_databases: [{
      binding: 'DB',
      database_name: section.d1.name,
      database_id: section.d1.id,
      // Enforced by assertCoreMigrationConfiguration in scripts/assert-repository-safety.mjs.
      migrations_dir: '.core-migrations/active',
    }],
    r2_buckets: [{ binding: 'ARCHIVE', bucket_name: section.r2.name, jurisdiction: 'eu' }],
    observability: { enabled: true },
  }
}

// The deployed worker validates its environment through worker/config.js loadConfig
// (including the APP_ORIGIN domain pin for staging/production), so every emitted env
// must pass that same schema — otherwise the writer would configure an environment
// the running worker rejects on every request. Importing the runtime module keeps
// the two in lockstep automatically when the domain pin changes.
const assertRuntimeAcceptsVars = (name, vars) => {
  try {
    loadConfig({
      ...vars,
      [`BWM_DATA_KEK_V${vars.ACTIVE_DATA_KEK_VERSION}`]: DUMMY_SECRET_KEY,
      [`BWM_LOOKUP_HMAC_V${vars.ACTIVE_LOOKUP_KEY_VERSION}`]: DUMMY_SECRET_KEY,
      [`BWM_BACKUP_KEK_V${vars.ACTIVE_BACKUP_KEK_VERSION}`]: DUMMY_SECRET_KEY,
      [`BWM_WORKBOOK_KEK_V${vars.ACTIVE_WORKBOOK_KEK_VERSION}`]: DUMMY_SECRET_KEY,
      [`BWM_WORKBOOK_HMAC_V${vars.ACTIVE_WORKBOOK_HMAC_VERSION}`]: DUMMY_SECRET_KEY,
    })
  } catch (error) {
    const detail = Array.isArray(error?.issues)
      ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      : error.message
    fail(`${name} vars were rejected by worker/config.js loadConfig: ${detail}`)
  }
}

export const applyProviderResults = ({ config, document }) => {
  if (!isPlainObject(document)) fail('provider document must be a JSON object')
  requireExactFields(document, 'provider document', ENVIRONMENT_NAMES)
  const inheritedVars = inheritedVersionVars(config)
  const local = localPlaceholders(config)
  for (const name of ENVIRONMENT_NAMES) {
    validateEnvironmentSection(name, document[name], local)
  }
  for (const [label, read] of DISTINCT_FIELDS) {
    if (read(document.staging) === read(document.production)) {
      fail(`staging and production must not share ${label}`)
    }
  }

  const warnings = []
  const env = {}
  for (const name of ENVIRONMENT_NAMES) {
    if (!Object.hasOwn(document[name], 'scaleway')) {
      warnings.push(`${name} has no scaleway section: SCW_* vars are omitted, so invitation emails will dead-letter until the email provider is configured`)
    }
    const block = buildEnvironmentBlock(name, document[name], inheritedVars)
    assertRuntimeAcceptsVars(name, block.vars)
    env[name] = block
  }

  const next = { ...config }
  next.secrets = {
    ...(isPlainObject(config.secrets) ? config.secrets : {}),
    required: [...REQUIRED_SECRETS],
  }
  next.env = env
  return { config: next, warnings }
}

export const serializeWranglerConfig = (config) => `${JSON.stringify(config, null, 2)}\n`

const parseArguments = (argv) => {
  let documentPath = null
  let wranglerPath = DEFAULT_WRANGLER_PATH
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--wrangler') {
      index += 1
      if (index === argv.length) fail(USAGE)
      wranglerPath = argv[index]
    } else if (argument.startsWith('-') || documentPath !== null) {
      fail(USAGE)
    } else {
      documentPath = argument
    }
  }
  if (documentPath === null) fail(USAGE)
  return { documentPath, wranglerPath }
}

const readJson = (path, label) => {
  let contents
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    fail(`Cannot read ${label}: ${path}`)
  }
  try {
    return JSON.parse(contents)
  } catch {
    fail(`Invalid JSON in ${label}: ${path}`)
  }
}

const runCli = () => {
  const { documentPath, wranglerPath } = parseArguments(process.argv.slice(2))
  const document = readJson(documentPath, 'provider document')
  const config = readJson(wranglerPath, 'wrangler config')
  const { config: nextConfig, warnings } = applyProviderResults({ config, document })
  for (const warning of warnings) console.error(`Warning: ${warning}`)
  writeFileSync(wranglerPath, serializeWranglerConfig(nextConfig))
  console.log(`Configured env.staging and env.production in ${wranglerPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
