import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hashPassword } from 'better-auth/crypto'
import { LOCAL_HARNESS_WRANGLER_NAME } from './local-harness-core.js'

const PASSWORD = 'correctpassword'
const USERS = Object.freeze([
  ['auth_local_owner', 'Alicja Testowa', 'owner@example.test', 'stf_local_owner'],
  ['auth_local_coordinator', 'Celina Testowa', 'coordinator@example.test', 'stf_local_coordinator'],
  ['auth_local_specialist', 'Zofia Fikcyjna', 'specialist@example.test', 'stf_local_specialist'],
])
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`

export async function buildLocalAuthSeedSql({ nowMs = Date.parse('2026-09-08T00:00:00.000Z') } = {}) {
  const password = await hashPassword(PASSWORD)
  return `${USERS.flatMap(([userId, name, email, staffId]) => [
    `INSERT OR IGNORE INTO auth_user (id,name,email,emailVerified,image,createdAt,updatedAt) VALUES (${sql(userId)},${sql(name)},${sql(email)},1,NULL,${nowMs},${nowMs})`,
    `INSERT OR IGNORE INTO auth_account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (${sql(`account_${userId}`)},${sql(userId)},'credential',${sql(userId)},${sql(password)},${nowMs},${nowMs})`,
    `INSERT OR IGNORE INTO staff_auth_identities (auth_user_id,staff_id,created_at) VALUES (${sql(userId)},${sql(staffId)},'2026-09-08T00:00:00.000Z')`,
  ]).join(';\n')};`
}

export async function runLocalAuthSeed({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.APP_ENV !== 'development' || env.DATA_MODE !== 'fictional') throw new Error('AUTH_SEED_REFUSED')
  const projectRoot = realpathSync(new URL('..', import.meta.url).pathname)
  const runner = env.BWM_LOCAL_RUNNER_MODE === 'runner-v1'
  const configPath = runner ? resolve(cwd, LOCAL_HARNESS_WRANGLER_NAME) : join(projectRoot, 'wrangler.json')
  const persistencePath = runner ? env.BWM_LOCAL_PERSISTENCE_PATH : join(projectRoot, '.wrangler/state')
  const baseArgs = [
    realpathSync(join(projectRoot, 'node_modules/wrangler/bin/wrangler.js')),
    '--config', configPath,
    '--x-provision=false', '--x-auto-create=false', '--install-skills=false',
    'd1', 'execute', 'DB', '--local', '--persist-to', persistencePath,
  ]
  const childEnv = { PATH: env.PATH, HOME: env.HOME }
  const preflight = spawnSync(process.execPath, [...baseArgs, '--command',
    "SELECT name FROM sqlite_master WHERE type='table' AND name='auth_user'", '--json'],
  { cwd, encoding: 'utf8', env: childEnv })
  if (preflight.status !== 0) throw new Error('AUTH_SEED_FAILED')
  let rows
  try { rows = JSON.parse(preflight.stdout)?.[0]?.results } catch { throw new Error('AUTH_SEED_FAILED') }
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('AUTH_SEED_FAILED')
  if (rows.length === 0) return Object.freeze({ ok: true, skipped: true })
  const result = spawnSync(process.execPath, [...baseArgs, '--command', await buildLocalAuthSeedSql()],
    { cwd, encoding: 'utf8', env: childEnv })
  if (result.status !== 0) throw new Error('AUTH_SEED_FAILED')
  return Object.freeze({ ok: true, skipped: false })
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) {
  runLocalAuthSeed().then((result) => process.stdout.write(result.skipped
    ? 'SEED_LOCAL_AUTH_SKIPPED\n' : 'SEED_LOCAL_AUTH_COMPLETE\n')).catch(() => {
    process.stderr.write('AUTH_SEED_FAILED\n')
    process.exitCode = 1
  })
}
