import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  createDemandBackupStore,
  createPinnedSourceRunner,
  validateStagingBackupConfig,
} from './backup-staging-lib.mjs'
import { migrationStatusEvidence } from './migration-status-staging-lib.mjs'

const executeFile = promisify(execFile)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const configuredWranglerPath = join(projectRoot, 'node_modules/wrangler/bin/wrangler.js')
const refused = () => { throw new Error('MIGRATION_STATUS_STAGING_REFUSED') }
const failed = () => { throw new Error('MIGRATION_STATUS_STAGING_FAILED') }

const requiredSecret = (environment, name) => {
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
  if (fromAllowed === '' || fromAllowed === '..' || fromAllowed.startsWith('../')
    || isAbsolute(fromAllowed)) refused()
  return resolved
}

async function main() {
  if (process.argv.length !== 2) refused()
  const config = JSON.parse(await readFile(join(projectRoot, 'wrangler.json'), 'utf8'))
  const selected = validateStagingBackupConfig({ config, environment: process.env })
  const apiToken = requiredSecret(process.env, 'CLOUDFLARE_API_TOKEN')
  const runner = createPinnedSourceRunner({
    tempRoot: tmpdir(),
    wranglerPath: await pinnedWranglerPath(),
    database: selected.database,
    execute: (args) => executeFile(process.execPath, args, {
      cwd: projectRoot,
      env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: apiToken },
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    }),
  })
  try {
    const store = createDemandBackupStore({ query: runner.query })
    const evidence = await migrationStatusEvidence(await store.readMigrations())
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
  } finally {
    await runner.cleanup()
  }
}

try {
  await main()
} catch (error) {
  const status = [
    'MIGRATION_STATUS_STAGING_REFUSED', 'BACKUP_STAGING_REFUSED',
  ].includes(error?.message) ? 'refused' : 'failed'
  process.stderr.write(`${JSON.stringify({ status })}\n`)
  process.exitCode = 1
}
