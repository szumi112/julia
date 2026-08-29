import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  boundedBody,
  boundedJsonResponse,
} from '../../scripts/backup-staging.mjs'

const cli = new URL('../../scripts/backup-staging.mjs', import.meta.url)
const run = (args, environment = {}) => spawnSync(process.execPath, [cli.pathname, ...args], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH, ...environment },
})

test('staging backup CLI refuses wrong environment and production confirmation without provider access', () => {
  for (const environment of [
    { APP_ENV: 'production', DATA_MODE: 'fictional' },
    { APP_ENV: 'staging', DATA_MODE: 'real' },
    { APP_ENV: 'staging', DATA_MODE: 'fictional', CLOUDFLARE_ENV: 'production' },
    { APP_ENV: 'staging', DATA_MODE: 'fictional', BWM_CONFIRM_PRODUCTION_DATABASE: 'secret-db' },
  ]) {
    const result = run(['create'], environment)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '{"status":"refused"}\n')
    assert.doesNotMatch(result.stderr, /secret-db|production|provider|Users\//)
  }
})

test('staging backup CLI enforces exact create/status/migrations grammar and fixed failures', () => {
  const environment = { APP_ENV: 'staging', DATA_MODE: 'fictional' }
  for (const args of [
    [],
    ['create', '--database', 'forbidden'],
    ['migrations', '--backup', 'bkp_forbidden'],
    ['status'],
    ['status', '--backup', '../escape'],
    ['status', '--backup', 'bkp_safe', '--extra'],
    ['unknown'],
  ]) {
    const result = run(args, environment)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '{"status":"refused"}\n')
    assert.doesNotMatch(result.stderr, /forbidden|escape|Users\//)
  }
})

test('missing credentials produce only the fixed failed result without naming secrets', () => {
  const result = run(['migrations'], { APP_ENV: 'staging', DATA_MODE: 'fictional' })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '{"status":"failed"}\n')
  assert.doesNotMatch(result.stderr, /CLOUDFLARE|TOKEN|R2_|BWM_|Users\//i)
})

test('demand CLI cancels oversized live JSON bodies including declared oversize', async () => {
  for (const declared of [false, true]) {
    let cancelled = false
    const stream = new ReadableStream({
      cancel() { cancelled = true },
      start(controller) {
        if (!declared) controller.enqueue(new Uint8Array(65_537))
      },
    })
    const response = new Response(stream, {
      headers: declared ? { 'content-length': '65537' } : {},
    })
    await assert.rejects(
      boundedJsonResponse(response),
      /^Error: BACKUP_STAGING_FAILED$/,
    )
    assert.equal(cancelled, true)
  }
})

test('demand CLI cancels failed manifest bodies and clears retained chunks', async () => {
  let cancelled = false
  const oversized = new Uint8Array([11, 12, 13, 14, 15])
  const live = new ReadableStream({
    cancel() { cancelled = true },
    start(controller) { controller.enqueue(oversized) },
  })
  await assert.rejects(boundedBody(live, 4), /^Error: BACKUP_STAGING_FAILED$/)
  assert.equal(cancelled, true)
  assert.deepEqual([...oversized], [0, 0, 0, 0, 0])

  const source = new Uint8Array([1, 2, 3])
  const result = await boundedBody(new ReadableStream({
    start(controller) {
      controller.enqueue(source)
      controller.close()
    },
  }))
  assert.deepEqual([...result], [1, 2, 3])
  assert.deepEqual([...source], [0, 0, 0])
})
