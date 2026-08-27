import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createKeyring } from '../worker/security/keyring.js'
import {
  createPinnedWranglerRunner,
  restoreBackup,
  validateRestoreRequest,
} from './restore-backup-lib.mjs'

const executeFile = promisify(execFile)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const wranglerPath = join(projectRoot, 'node_modules/wrangler/bin/wrangler.js')
const MANIFEST_MAX_BYTES = 64 * 1024

function argumentsFrom(argv) {
  const names = new Map([
    ['--manifest', 'manifestKey'],
    ['--target', 'target'],
    ['--sentinel', 'sentinel'],
  ])
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index])
    const value = argv[index + 1]
    if (!key || typeof value !== 'string' || value.length === 0 || Object.hasOwn(result, key)) {
      throw new Error('RESTORE_REFUSED')
    }
    result[key] = value
  }
  if (Object.keys(result).length !== names.size) throw new Error('RESTORE_REFUSED')
  return result
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

const requiredEnvironment = (environment, name) => {
  const value = environment[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error('RESTORE_REFUSED')
  return value
}

const bodyBytes = async (body) => {
  if (body instanceof Uint8Array) {
    if (body.byteLength > MANIFEST_MAX_BYTES) throw new Error('RESTORE_FAILED')
    return body
  }
  if (typeof body?.transformToByteArray === 'function') {
    const bytes = new Uint8Array(await body.transformToByteArray())
    if (bytes.byteLength > MANIFEST_MAX_BYTES) throw new Error('RESTORE_FAILED')
    return bytes
  }
  throw new Error('RESTORE_FAILED')
}

const bodyStream = (body) => {
  if (body instanceof ReadableStream) return body
  if (typeof body?.transformToWebStream === 'function') return body.transformToWebStream()
  throw new Error('RESTORE_FAILED')
}

async function main() {
  const controller = new AbortController()
  const request = argumentsFrom(process.argv.slice(2))
  const config = JSON.parse(await readFile(join(projectRoot, 'wrangler.json'), 'utf8'))
  const policy = databaseFacts(config)
  validateRestoreRequest({ request, ...policy })
  const expectedMigrations = (await readdir(join(projectRoot, 'migrations')))
    .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(name))
    .sort()

  const accountId = requiredEnvironment(process.env, 'CF_ACCOUNT_ID')
  const accessKeyId = requiredEnvironment(process.env, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = requiredEnvironment(process.env, 'R2_SECRET_ACCESS_KEY')
  const apiToken = requiredEnvironment(process.env, 'CLOUDFLARE_API_TOKEN')
  const staging = config.env?.staging
  const bucket = staging?.r2_buckets?.[0]?.bucket_name
  if (typeof bucket !== 'string' || staging.r2_buckets[0].jurisdiction !== 'eu') {
    throw new Error('RESTORE_REFUSED')
  }
  const activeBackupKekVersion = Number(staging.vars?.ACTIVE_BACKUP_KEK_VERSION)
  const keyring = await createKeyring(process.env, { activeBackupKekVersion })
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.eu.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  const customerParameters = (ssecKey) => ({
    SSECustomerAlgorithm: 'AES256',
    SSECustomerKey: Buffer.from(ssecKey).toString('base64'),
  })
  const provider = {
    async describeDatabase(target) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
        {
          headers: { Authorization: `Bearer ${apiToken}` },
          redirect: 'error',
          signal: controller.signal,
        },
      )
      if (!response.ok || response.redirected) throw new Error('RESTORE_FAILED')
      const payload = await response.json()
      const matches = payload?.success === true && Array.isArray(payload.result)
        ? payload.result.filter(({ name }) => name === target)
        : []
      if (matches.length !== 1) throw new Error('RESTORE_REFUSED')
      return {
        name: matches[0].name,
        id: matches[0].uuid,
        jurisdiction: matches[0].jurisdiction,
      }
    },
    async getManifest(key) {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: controller.signal },
      )
      return bodyBytes(response.Body)
    },
    async headObject({ key, ssecKey }) {
      const response = await s3.send(
        new HeadObjectCommand({
          Bucket: bucket, Key: key, ...customerParameters(ssecKey),
        }),
        { abortSignal: controller.signal },
      )
      return {
        etag: response.ETag?.replace(/^"|"$/g, ''),
        size: response.ContentLength,
        customMetadata: {
          backupId: response.Metadata?.backupid,
          format: response.Metadata?.format,
          retentionClass: response.Metadata?.retentionclass,
        },
      }
    },
    async getObject({ key, ssecKey }) {
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: bucket, Key: key, ...customerParameters(ssecKey),
        }),
        { abortSignal: controller.signal },
      )
      return bodyStream(response.Body)
    },
  }
  const commandRunner = createPinnedWranglerRunner({
    tempRoot: tmpdir(),
    wranglerPath,
    execute: (args) => executeFile(process.execPath, args, {
      cwd: projectRoot,
      env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: apiToken },
      maxBuffer: 1024 * 1024,
      signal: controller.signal,
    }),
  })

  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const result = await restoreBackup({
      request,
      ...policy,
      expectedMigrations,
      tempRoot: tmpdir(),
      keyring,
      provider,
      runCommand: commandRunner.runCommand,
      log() {},
      signal: controller.signal,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    await commandRunner.cleanup()
  }
}

try {
  await main()
} catch (error) {
  const status = error?.message === 'RESTORE_REFUSED' ? 'refused' : 'failed'
  process.stderr.write(`${JSON.stringify({ status })}\n`)
  process.exitCode = 1
}
