import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runAppE2E } from '../../scripts/run-app-e2e.mjs'

const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux'
const PROJECT_ROOT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)))
const RUNNER_PATH = realpathSync(fileURLToPath(new URL('../../scripts/run-app-e2e.mjs', import.meta.url)))
const READY_URL = 'http://127.0.0.1:5174/api/v1/session'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForSession = async (childExited) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (childExited()) throw new Error('runner exited before exposing the session')
    try {
      const response = await fetch(READY_URL, {
        cache: 'no-store',
        headers: {
          Connection: 'close',
          'X-BWM-Local-Identity': 'owner@example.test',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(500),
      })
      await response.arrayBuffer()
      if (response.status === 200 && response.url === READY_URL) return
    } catch {
      // Vite is still starting.
    }
    await delay(50)
  }
  throw new Error('runner session readiness deadline exceeded')
}

const waitForOutput = async (readOutput, childExited) => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (readOutput() === 'APP_E2E_READY\n') return
    if (childExited()) throw new Error('runner exited before reporting readiness')
    await delay(10)
  }
  throw new Error('runner did not report APP_E2E_READY')
}

test('default runner exposes the exact seeded owner through one shared local D1', {
  skip: !SUPPORTED,
  timeout: 60_000,
}, async () => {
  const result = await runAppE2E({
    argv: [],
    env: {
      CF_API_TOKEN: 'must-not-reach-child',
      HTTPS_PROXY: 'http://must-not-reach-child.invalid',
      SENTINEL_PARENT_SECRET: 'must-not-reach-child',
    },
    deps: {
      exitAfterReady: true,
      maxReadinessAttempts: 120,
    },
  })
  assert.deepEqual(result, { code: 'APP_E2E_READY', ok: true })
})

test('runner CLI reports readiness once, stays live, and reports its terminal signal result', {
  skip: !SUPPORTED,
  timeout: 60_000,
}, async () => {
  const child = spawn(realpathSync(process.execPath), [RUNNER_PATH], {
    cwd: PROJECT_ROOT,
    detached: true,
    env: {
      CF_API_TOKEN: 'must-not-reach-child-or-output',
      HTTPS_PROXY: 'http://must-not-reach-child.invalid',
      SENTINEL_PARENT_SECRET: 'must-not-reach-child-or-output',
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exit = null
  let stderr = ''
  let stdout = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  const childExit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      exit = { code, signal }
      resolve(exit)
    })
  })

  try {
    await waitForSession(() => exit)
    await waitForOutput(() => stdout, () => exit)
    assert.equal(exit, null)
    assert.equal(stderr, '')

    child.kill('SIGINT')
    assert.deepEqual(await childExit, { code: 1, signal: null })
    assert.equal(stdout, 'APP_E2E_READY\nAPP_E2E_INTERRUPTED\n')
    assert.equal(stderr, '')
    assert.doesNotMatch(`${stdout}\n${stderr}`, /must-not-reach/)
  } finally {
    if (!exit) {
      child.kill('SIGTERM')
      const stopped = await Promise.race([
        childExit.then(() => true),
        delay(5_000).then(() => false),
      ])
      if (!stopped) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already absent. */ }
        await childExit
      }
    }
  }
})
