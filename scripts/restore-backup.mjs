import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createKeyring } from '../worker/security/keyring.js'
import {
  createDemandBackupStore,
  createPinnedSourceRunner,
  validateStagingBackupConfig,
} from './backup-staging-lib.mjs'
import {
  createPinnedWranglerRunner,
  restoreBackup,
  validateRestoreRequest,
} from './restore-backup-lib.mjs'

const executeFile = promisify(execFile)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const configuredWranglerPath = join(projectRoot, 'node_modules/wrangler/bin/wrangler.js')
const MANIFEST_MAX_BYTES = 64 * 1024
const RESPONSE_MAX_BYTES = 64 * 1024

const refused = () => { throw new Error('RESTORE_REFUSED') }
const failed = () => { throw new Error('RESTORE_FAILED') }
const ownObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

function argumentsFrom(argv) {
  const result = { allowLegacyUnverified: false }
  for (let index = 0; index < argv.length;) {
    const name = argv[index]
    if (name === '--allow-legacy-unverified') {
      if (result.allowLegacyUnverified) refused()
      result.allowLegacyUnverified = true
      index += 1
      continue
    }
    if (!['--manifest', '--target'].includes(name)
      || typeof argv[index + 1] !== 'string' || argv[index + 1].startsWith('--')) refused()
    const key = name === '--manifest' ? 'manifestKey' : 'target'
    if (Object.hasOwn(result, key) || argv[index + 1].length === 0) refused()
    result[key] = argv[index + 1]
    index += 2
  }
  if (!Object.hasOwn(result, 'manifestKey') || !Object.hasOwn(result, 'target')) refused()
  return {
    manifestKey: result.manifestKey,
    target: result.target,
    allowLegacyUnverified: result.allowLegacyUnverified,
  }
}

function requiredEnvironment(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) refused()
  return value
}

async function pinnedWranglerPath() {
  const stats = await lstat(configuredWranglerPath)
  if (!stats.isFile() || stats.isSymbolicLink()) refused()
  const resolved = await realpath(configuredWranglerPath)
  const allowed = await realpath(join(projectRoot, 'node_modules/wrangler'))
  const fromAllowed = relative(allowed, resolved)
  if (fromAllowed === '' || fromAllowed === '..' || fromAllowed.startsWith('../') || isAbsolute(fromAllowed)) refused()
  return resolved
}

const databaseFacts = (config) => {
  const rows = [
    ...(config.d1_databases ?? []),
    ...Object.values(config.env ?? {}).flatMap((section) => section.d1_databases ?? []),
  ]
  const production = config.env?.production?.d1_databases ?? []
  return {
    sourceDatabaseNames: rows.map(({ database_name: name }) => name),
    sourceDatabaseIds: rows.map(({ database_id: id }) => id),
    productionDatabaseNames: production.map(({ database_name: name }) => name),
    productionDatabaseIds: production.map(({ database_id: id }) => id),
  }
}

async function boundedJson(response) {
  if (!(response instanceof Response) || !response.ok || response.redirected || !(response.body instanceof ReadableStream)) failed()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) failed()
      total += part.value.byteLength
      if (total > RESPONSE_MAX_BYTES) failed()
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { failed() } finally { bytes.fill(0) }
}

function bodyStream(body) {
  if (body instanceof ReadableStream) return body
  if (typeof body?.transformToWebStream === 'function') return body.transformToWebStream()
  failed()
}

async function boundedBody(body) {
  const reader = bodyStream(body).getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) failed()
      total += part.value.byteLength
      if (total > MANIFEST_MAX_BYTES) failed()
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

async function main() {
  const controller = new AbortController()
  const request = argumentsFrom(process.argv.slice(2))
  const config = JSON.parse(await readFile(join(projectRoot, 'wrangler.json'), 'utf8'))
  const selection = validateStagingBackupConfig({ config, environment: process.env })
  const policy = databaseFacts(config)
  validateRestoreRequest({ request, ...policy })
  const apiToken = requiredEnvironment(process.env, 'CLOUDFLARE_API_TOKEN')
  const accessKeyId = requiredEnvironment(process.env, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = requiredEnvironment(process.env, 'R2_SECRET_ACCESS_KEY')
  const keyring = await createKeyring(process.env, { activeBackupKekVersion: selection.activeBackupKekVersion })
  const wranglerPath = await pinnedWranglerPath()
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${selection.source.accountId}.eu.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  const execute = (args) => executeFile(process.execPath, args, {
    cwd: projectRoot,
    env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: apiToken },
    maxBuffer: 1024 * 1024,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
  })
  const targetRunner = createPinnedWranglerRunner({ tempRoot: tmpdir(), wranglerPath, execute })
  const sourceRunner = createPinnedSourceRunner({ tempRoot: tmpdir(), wranglerPath, database: selection.database, execute })
  const sourceStore = createDemandBackupStore({ query: sourceRunner.query })
  const customerParameters = (ssecKey) => ({
    SSECustomerAlgorithm: 'AES256',
    SSECustomerKey: Buffer.from(ssecKey).toString('base64'),
  })
  const providerSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
  const provider = {
    async describeDatabase(targetName) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${selection.source.accountId}/d1/database?name=${encodeURIComponent(targetName)}&per_page=10`,
        { headers: { Authorization: `Bearer ${apiToken}` }, redirect: 'error', signal: providerSignal() },
      )
      const payload = await boundedJson(response)
      const matches = ownObject(payload) && payload.success === true && Array.isArray(payload.result)
        ? payload.result.filter((row) => ownObject(row) && row.name === targetName)
        : []
      if (matches.length !== 1) refused()
      return { name: matches[0].name, id: matches[0].uuid, jurisdiction: matches[0].jurisdiction }
    },
    async getManifest(key) {
      const response = await s3.send(new GetObjectCommand({ Bucket: selection.archive.bucket, Key: key }), { abortSignal: providerSignal() })
      return boundedBody(response.Body)
    },
    async headObject({ key, ssecKey }) {
      const response = await s3.send(new HeadObjectCommand({
        Bucket: selection.archive.bucket, Key: key, ...customerParameters(ssecKey),
      }), { abortSignal: providerSignal() })
      const format = response.Metadata?.format
      const customMetadata = format === 'bwm-d1-sql-v2'
        ? {
            backupId: response.Metadata?.backupid,
            format,
            retentionClass: response.Metadata?.retentionclass,
            sourceAppEnv: response.Metadata?.sourceappenv,
            sourceDatabaseId: response.Metadata?.sourcedatabaseid,
          }
        : {
            backupId: response.Metadata?.backupid,
            format,
            retentionClass: response.Metadata?.retentionclass,
          }
      return { etag: response.ETag?.replace(/^"|"$/g, ''), size: response.ContentLength, customMetadata }
    },
    async getObject({ key, ssecKey }) {
      const response = await s3.send(new GetObjectCommand({
        Bucket: selection.archive.bucket, Key: key, ...customerParameters(ssecKey),
      }), { abortSignal: providerSignal() })
      return bodyStream(response.Body)
    },
    async markRestoreVerified(facts) {
      const verifiedAt = new Date().toISOString()
      return sourceStore.markRestoreVerified({ ...facts, verifiedAt })
    },
    async readSourceBackup({ backupId }) { return sourceStore.readBackup({ backupId }) },
  }
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const result = await restoreBackup({
      request,
      expectedSource: selection.source,
      ...policy,
      tempRoot: tmpdir(),
      keyring,
      provider,
      runCommand: targetRunner.runCommand,
      log() {},
      signal: controller.signal,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    try { await targetRunner.cleanup() } catch {}
    try { await sourceRunner.cleanup() } catch {}
    try { s3.destroy() } catch {}
  }
}

try {
  await main()
} catch (error) {
  const status = error?.message === 'RESTORE_REFUSED' || error?.message === 'BACKUP_STAGING_REFUSED'
    ? 'refused'
    : 'failed'
  process.stderr.write(`${JSON.stringify({ status })}\n`)
  process.exitCode = 1
}
