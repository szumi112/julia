import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createD1DatabaseFacade, createD1RestClient } from './bootstrap-owner.mjs'
import { createKeyring } from '../worker/security/keyring.js'
import {
  validateStagingBackupConfig,
} from './backup-staging-lib.mjs'
import {
  createPinnedWranglerRunner,
  createRestoreSourceStore,
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

export async function readBoundedJson(response) {
  if (!(response instanceof Response) || !response.ok || response.redirected || !(response.body instanceof ReadableStream)) failed()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  let completed = false
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) failed()
      if (!Number.isSafeInteger(total + part.value.byteLength)) failed()
      total += part.value.byteLength
      if (total > RESPONSE_MAX_BYTES) failed()
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try {
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      completed = true
      return result
    } catch { failed() } finally { bytes.fill(0) }
  } finally {
    if (!completed) {
      try { await reader.cancel() } catch {}
    }
    for (const chunk of chunks) chunk.fill(0)
    try { reader.releaseLock() } catch {}
  }
}

function bodyStream(body) {
  if (body instanceof ReadableStream) return body
  if (typeof body?.transformToWebStream === 'function') return body.transformToWebStream()
  failed()
}

function pairedEtag(value) {
  if (typeof value !== 'string' || !/^"[^"\r\n]+"$/.test(value)) failed()
  const etag = value.slice(1, -1)
  if (etag.length < 1 || etag.length > 1024 || etag !== etag.trim()
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(etag)) failed()
  return etag
}

function quotedEtag(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
    || value.includes('"') || value !== value.trim()
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) failed()
  return `"${value}"`
}

function objectMetadata(value) {
  if (!ownObject(value)) failed()
  const format = value.format
  const keys = format === 'bwm-d1-sql-v1'
    ? ['backupid', 'format', 'retentionclass']
    : ['backupid', 'format', 'retentionclass', 'sourceappenv', 'sourcedatabaseid']
  if (Reflect.ownKeys(value).length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))) failed()
  return format === 'bwm-d1-sql-v1'
    ? {
        backupId: value.backupid,
        format,
        retentionClass: value.retentionclass,
      }
    : {
        backupId: value.backupid,
        format,
        retentionClass: value.retentionclass,
        sourceAppEnv: value.sourceappenv,
        sourceDatabaseId: value.sourcedatabaseid,
      }
}

export async function readBoundedManifestBody(body) {
  const reader = bodyStream(body).getReader()
  const chunks = []
  let total = 0
  let completed = false
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) failed()
      if (!Number.isSafeInteger(total + part.value.byteLength)) failed()
      total += part.value.byteLength
      if (total > MANIFEST_MAX_BYTES) failed()
      chunks.push(part.value)
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    completed = true
    return result
  } finally {
    if (!completed) {
      try { await reader.cancel() } catch {}
    }
    for (const chunk of chunks) chunk.fill(0)
    try { reader.releaseLock() } catch {}
  }
}

export function sseCustomerParameters(ssecKey) {
  if (!(ssecKey instanceof Uint8Array) || !(ssecKey.buffer instanceof ArrayBuffer)
    || ssecKey.byteOffset !== 0 || ssecKey.byteLength !== 32
    || ssecKey.buffer.byteLength !== 32) failed()
  return {
    SSECustomerAlgorithm: 'AES256',
    SSECustomerKey: Buffer.from(ssecKey.buffer, 0, 32).toString('base64'),
  }
}

const RESTORE_RESULT_KEYS = Object.freeze([
  'backupId', 'format', 'migrationCount', 'migrationSetSha256', 'recoveryKind',
  'target', 'manifestAuthenticated', 'objectReadbackVerified',
  'migrationsVerified', 'recoveryFactsVerified', 'restoreSentinelVerified',
  'sourceMarkedVerified', 'targetFreshVerified',
])

export function restoreCliLine(value) {
  if (!ownObject(value)
    || !Reflect.ownKeys(value).every((key, index) => key === RESTORE_RESULT_KEYS[index])
    || Reflect.ownKeys(value).length !== RESTORE_RESULT_KEYS.length
    || typeof value.backupId !== 'string' || typeof value.target !== 'string'
    || !['bwm-d1-sql-v1', 'bwm-d1-sql-v2', 'bwm-d1-sql-v3'].includes(value.format)
    || !Number.isSafeInteger(value.migrationCount) || value.migrationCount < 1
    || !/^[0-9a-f]{64}$/.test(value.migrationSetSha256)
    || !['manifestAuthenticated', 'objectReadbackVerified', 'migrationsVerified',
      'recoveryFactsVerified', 'restoreSentinelVerified', 'sourceMarkedVerified',
      'targetFreshVerified'].every((key) => typeof value[key] === 'boolean')) failed()
  const expected = value.format === 'bwm-d1-sql-v1'
    ? [null, false, false, false, false]
    : value.format === 'bwm-d1-sql-v2'
      ? [null, true, false, true, true]
      : [value.recoveryKind, true, true, true, true]
  if ((value.format === 'bwm-d1-sql-v3'
    && !['core_pre_workbook_v1', 'workbook_roundtrip_v1'].includes(value.recoveryKind))
    || [value.recoveryKind, value.migrationsVerified, value.recoveryFactsVerified,
      value.restoreSentinelVerified, value.sourceMarkedVerified]
      .some((entry, index) => entry !== expected[index])
    || value.manifestAuthenticated !== true || value.objectReadbackVerified !== true
    || value.targetFreshVerified !== true) failed()
  return `${JSON.stringify(value)}\n`
}

async function main() {
  const controller = new AbortController()
  const request = argumentsFrom(process.argv.slice(2))
  const config = JSON.parse(await readFile(join(projectRoot, 'wrangler.json'), 'utf8'))
  const selection = validateStagingBackupConfig({ config, environment: process.env })
  const policy = databaseFacts(config)
  validateRestoreRequest({ request, ...policy })
  const apiToken = requiredEnvironment(process.env, 'CLOUDFLARE_API_TOKEN')
  const d1Token = requiredEnvironment(process.env, 'CF_D1_EXPORT_TOKEN')
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
  const sourceStore = createRestoreSourceStore({
    db: createD1DatabaseFacade(createD1RestClient({
      accountId: selection.source.accountId,
      databaseId: selection.source.databaseId,
      token: d1Token,
      fetch,
      deadlineSignal: (milliseconds) => AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(milliseconds),
      ]),
    })),
  })
  const providerSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
  const provider = {
    async describeDatabase(targetName) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${selection.source.accountId}/d1/database?name=${encodeURIComponent(targetName)}&per_page=10`,
        { headers: { Authorization: `Bearer ${apiToken}` }, redirect: 'error', signal: providerSignal() },
      )
      const payload = await readBoundedJson(response)
      const matches = ownObject(payload) && payload.success === true && Array.isArray(payload.result)
        ? payload.result.filter((row) => ownObject(row) && row.name === targetName)
        : []
      if (matches.length !== 1) refused()
      return { name: matches[0].name, id: matches[0].uuid, jurisdiction: matches[0].jurisdiction }
    },
    async headManifest({ key }) {
      const response = await s3.send(new HeadObjectCommand({
        Bucket: selection.archive.bucket,
        Key: key,
      }), { abortSignal: providerSignal() })
      return { etag: pairedEtag(response.ETag), size: response.ContentLength }
    },
    async getManifest({ key, ifMatch }) {
      const response = await s3.send(new GetObjectCommand({
        Bucket: selection.archive.bucket,
        Key: key,
        IfMatch: quotedEtag(ifMatch),
      }), { abortSignal: providerSignal() })
      return {
        etag: pairedEtag(response.ETag),
        size: response.ContentLength,
        bytes: await readBoundedManifestBody(response.Body),
      }
    },
    async headObject({ key, ssecKey }) {
      const response = await s3.send(new HeadObjectCommand({
        Bucket: selection.archive.bucket, Key: key, ...sseCustomerParameters(ssecKey),
      }), { abortSignal: providerSignal() })
      return {
        etag: pairedEtag(response.ETag),
        size: response.ContentLength,
        customMetadata: objectMetadata(response.Metadata),
      }
    },
    async getObject({ key, ssecKey, ifMatch }) {
      const response = await s3.send(new GetObjectCommand({
        Bucket: selection.archive.bucket,
        Key: key,
        IfMatch: quotedEtag(ifMatch),
        ...sseCustomerParameters(ssecKey),
      }), { abortSignal: providerSignal() })
      return {
        etag: pairedEtag(response.ETag),
        size: response.ContentLength,
        body: bodyStream(response.Body),
      }
    },
    async markRestoreVerified(facts) { return sourceStore.markRestoreVerified(facts) },
    async readSourceBackup({ backupId }) { return sourceStore.readSourceBackup({ backupId }) },
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
      cleanupTarget: targetRunner.cleanup,
      signal: controller.signal,
    })
    process.stdout.write(restoreCliLine(result))
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    try { s3.destroy() } catch {}
  }
}

const invokedDirectly = typeof process.argv[1] === 'string'
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    const status = error?.message === 'RESTORE_REFUSED' || error?.message === 'BACKUP_STAGING_REFUSED'
      ? 'refused'
      : 'failed'
    process.stderr.write(`${JSON.stringify({ status })}\n`)
    process.exitCode = 1
  }
}
