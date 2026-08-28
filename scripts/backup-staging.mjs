import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createKeyring } from '../worker/security/keyring.js'
import { downloadD1Export, pollD1Export } from '../worker/operations/backups.js'
import {
  createDemandBackupStore,
  createPinnedSourceRunner,
  createS3BackupArchive,
  createStagingBackup,
  stagingMigrationStatus,
  statusStagingBackup,
  validateStagingBackupConfig,
} from './backup-staging-lib.mjs'

const executeFile = promisify(execFile)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const configuredWranglerPath = join(projectRoot, 'node_modules/wrangler/bin/wrangler.js')
const MANIFEST_MAX_BYTES = 64 * 1024
const RESPONSE_MAX_BYTES = 64 * 1024
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/

const refused = () => { throw new Error('BACKUP_STAGING_REFUSED') }
const failed = () => { throw new Error('BACKUP_STAGING_FAILED') }
const ownObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

function argumentsFrom(argv) {
  if (argv.length === 1 && ['create', 'migrations'].includes(argv[0])) return { operation: argv[0], backupId: null }
  if (argv.length === 3 && argv[0] === 'status' && argv[1] === '--backup' && BACKUP_ID.test(argv[2])) {
    return { operation: 'status', backupId: argv[2] }
  }
  refused()
}

function requiredEnvironment(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) failed()
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

export async function boundedJsonResponse(response) {
  if (!(response instanceof Response)) failed()
  if (!response.ok || response.redirected || !(response.body instanceof ReadableStream)) {
    try { await response.body?.cancel() } catch {}
    failed()
  }
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length)
    || !Number.isSafeInteger(Number(length)) || Number(length) > RESPONSE_MAX_BYTES)) {
    try { await response.body.cancel() } catch {}
    failed()
  }
  const reader = response.body.getReader()
  const chunks = []
  let bytes
  let completed = false
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) failed()
      chunks.push(part.value)
      if (!Number.isSafeInteger(total + part.value.byteLength)) failed()
      total += part.value.byteLength
      if (total > RESPONSE_MAX_BYTES) failed()
    }
    bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let result
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { failed() }
    completed = true
    return result
  } finally {
    if (!completed) {
      try { await reader.cancel() } catch {}
    }
    for (const chunk of chunks) chunk.fill(0)
    bytes?.fill(0)
    try { reader.releaseLock() } catch {}
  }
}

async function describeConfiguredSource(selection, apiToken, signal) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${selection.source.accountId}/d1/database/${selection.database.id}`,
    {
      headers: { Authorization: `Bearer ${apiToken}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    },
  )
  const payload = await boundedJsonResponse(response)
  if (!ownObject(payload) || payload.success !== true || !ownObject(payload.result)
    || payload.result.uuid !== selection.database.id || payload.result.name !== selection.database.name
    || payload.result.jurisdiction !== 'eu') refused()
}

function bodyStream(body) {
  if (body instanceof ReadableStream) return body
  if (typeof body?.transformToWebStream === 'function') return body.transformToWebStream()
  failed()
}

export async function boundedBody(body, maximum = MANIFEST_MAX_BYTES) {
  const stream = bodyStream(body)
  if (!Number.isSafeInteger(maximum) || maximum < 1) failed()
  const reader = stream.getReader()
  const chunks = []
  let completed = false
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) failed()
      chunks.push(part.value)
      if (!Number.isSafeInteger(total + part.value.byteLength)) failed()
      total += part.value.byteLength
      if (total > maximum) failed()
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

const randomId = (prefix) => `${prefix}${crypto.randomUUID().replaceAll('-', '')}`

async function main() {
  const command = argumentsFrom(process.argv.slice(2))
  const config = JSON.parse(await readFile(join(projectRoot, 'wrangler.json'), 'utf8'))
  const selection = validateStagingBackupConfig({ config, environment: process.env })
  const apiToken = requiredEnvironment(process.env, 'CLOUDFLARE_API_TOKEN')
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  let runner
  let s3
  try {
    await describeConfiguredSource(selection, apiToken, controller.signal)
    runner = createPinnedSourceRunner({
      tempRoot: tmpdir(),
      wranglerPath: await pinnedWranglerPath(),
      database: selection.database,
      execute: (args) => executeFile(process.execPath, args, {
        cwd: projectRoot,
        env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: apiToken },
        maxBuffer: 1024 * 1024,
        signal: controller.signal.aborted
          ? AbortSignal.timeout(60_000)
          : AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      }),
    })
    const store = createDemandBackupStore({ query: runner.query })
    if (command.operation === 'migrations') {
      process.stdout.write(`${JSON.stringify(await stagingMigrationStatus({ store }))}\n`)
      return
    }

    const accessKeyId = requiredEnvironment(process.env, 'R2_ACCESS_KEY_ID')
    const secretAccessKey = requiredEnvironment(process.env, 'R2_SECRET_ACCESS_KEY')
    const keyring = await createKeyring(process.env, {
      activeBackupKekVersion: selection.activeBackupKekVersion,
    })
    s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${selection.source.accountId}.eu.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    })
    if (command.operation === 'status') {
      const result = await statusStagingBackup({
        backupId: command.backupId,
        store,
        keyring,
        source: selection.source,
        async getManifest(key) {
          const response = await s3.send(new GetObjectCommand({ Bucket: selection.archive.bucket, Key: key }), {
            abortSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
          })
          return boundedBody(response.Body)
        },
      })
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return
    }

    const exportToken = requiredEnvironment(process.env, 'CF_D1_EXPORT_TOKEN')
    const archive = createS3BackupArchive({ client: s3, bucket: selection.archive.bucket })
    const result = await createStagingBackup({
      source: selection.source,
      store,
      archive,
      keyring,
      now: Date.now,
      backupIdFactory: () => randomId('bkp_demand_'),
      leaseOwnerFactory: () => randomId('lease_demand_'),
      nonceFactory: () => crypto.getRandomValues(new Uint8Array(12)),
      rawKeyFactory: () => crypto.getRandomValues(new Uint8Array(32)),
      pollExport: ({ signal }) => pollD1Export({
        accountId: selection.source.accountId,
        databaseId: selection.source.databaseId,
        token: exportToken,
        fetch,
        wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        now: Date.now,
        signal,
      }),
      downloadExport: ({ downloadUrl, signal }) => downloadD1Export({
        downloadUrl,
        fetch,
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      }),
      signal: controller.signal,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    try { await runner?.cleanup() } catch {}
    try { s3?.destroy() } catch {}
  }
}

const invokedDirectly = typeof process.argv[1] === 'string'
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    const status = error?.message === 'BACKUP_STAGING_REFUSED' ? 'refused' : 'failed'
    process.stderr.write(`${JSON.stringify({ status })}\n`)
    process.exitCode = 1
  }
}
