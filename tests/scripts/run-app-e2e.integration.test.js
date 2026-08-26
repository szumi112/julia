import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runAppE2E } from '../../scripts/run-app-e2e.mjs'

const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux'
const PROJECT_ROOT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)))
const RUNNER_PATH = realpathSync(fileURLToPath(new URL('../../scripts/run-app-e2e.mjs', import.meta.url)))
const READY_URL = 'http://127.0.0.1:5174/api/v1/session'
const OWNERSHIP_MARKER = Buffer.from('BWM_APP_E2E_OWNERSHIP=', 'ascii')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const runnerTemporaryRoots = () => readdirSync(realpathSync(tmpdir()), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('bwm-app-e2e-'))
  .map((entry) => entry.name)
  .sort()

const ownershipMarkerSnapshot = () => {
  const snapshot = spawnSync(
    realpathSync('/bin/ps'),
    ['eww', '-axo', 'pid=,ppid=,pgid=,command='],
    {
      env: { LANG: 'C', LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      timeout: 500,
    },
  )
  const stdout = snapshot.stdout
  const stderr = snapshot.stderr
  try {
    assert.equal(
      snapshot.error === undefined
        && snapshot.signal === null
        && snapshot.status === 0
        && stdout instanceof Buffer
        && stderr instanceof Buffer
        && stderr.byteLength === 0,
      true,
      'ownership process snapshot failed',
    )
    const ownership = new Map()
    let offset = 0
    while (offset < stdout.byteLength) {
      const index = stdout.indexOf(OWNERSHIP_MARKER, offset)
      if (index < 0) break
      const tokenStart = index + OWNERSHIP_MARKER.byteLength
      const tokenEnd = tokenStart + 48
      const token = stdout.subarray(tokenStart, tokenEnd).toString('ascii')
      const before = index > 0 ? stdout[index - 1] : 0x0a
      const after = tokenEnd < stdout.byteLength ? stdout[tokenEnd] : 0x0a
      if ((before !== 0x20 && before !== 0x09)
        || (after !== 0x20 && after !== 0x09 && after !== 0x0a)
        || !/^[a-f0-9]{48}$/.test(token)) {
        offset = tokenEnd
        continue
      }
      const lineStart = stdout.lastIndexOf(0x0a, index - 1) + 1
      const prefix = stdout.subarray(
        lineStart,
        Math.min(index, lineStart + 96),
      ).toString('ascii')
      const match = prefix.match(/^\s*[1-9]\d*\s+(?:0|[1-9]\d*)\s+([1-9]\d*)\s+/)
      assert.notEqual(match, null, 'ownership process snapshot was malformed')
      const groups = ownership.get(token) ?? new Set()
      groups.add(Number(match[1]))
      ownership.set(token, groups)
      offset = tokenEnd
    }
    return ownership
  } finally {
    stdout?.fill?.(0)
    stderr?.fill?.(0)
  }
}

const assertRunnerResourcesAbsent = async () => {
  assert.equal(ownershipMarkerSnapshot().size, 0)
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error('runner port remains occupied')))
    server.listen({
      exclusive: true,
      host: '127.0.0.1',
      port: 5174,
    }, () => {
      server.close((error) => {
        if (error) reject(new Error('runner port release failed'))
        else resolve()
      })
    })
  })
}

const waitForRunnerResourcesAbsent = async () => {
  let failure = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertRunnerResourcesAbsent()
      return
    } catch (error) {
      failure = error
    }
    await delay(50)
  }
  throw failure ?? new Error('runner resources remain observable')
}

const killOwnedGroups = (ownershipToken) => {
  if (!ownershipToken) return
  const groups = ownershipMarkerSnapshot().get(ownershipToken) ?? new Set()
  for (const groupId of groups) {
    try { process.kill(-groupId, 'SIGKILL') } catch { /* Already absent. */ }
  }
}

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
  await assertRunnerResourcesAbsent()
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
  await assertRunnerResourcesAbsent()
})

test('default private Vite transforms the real browser entry from its isolated root', {
  skip: !SUPPORTED,
  timeout: 60_000,
}, async (t) => {
  await assertRunnerResourcesAbsent()
  const temporaryRootsBefore = runnerTemporaryRoots()
  let ownershipToken = null
  t.after(async () => {
    killOwnedGroups(ownershipToken)
    await waitForRunnerResourcesAbsent()
    assert.deepEqual(runnerTemporaryRoots(), temporaryRootsBefore)
  })

  let probe = null
  const result = await runAppE2E({
    argv: [],
    env: {
      HTTPS_PROXY: 'http://must-not-reach-child.invalid',
      SENTINEL_PARENT_SECRET: 'must-not-reach-browser-module',
    },
    deps: {
      maxReadinessAttempts: 120,
      onReady: async () => {
        const ownership = ownershipMarkerSnapshot()
        assert.equal(ownership.size, 1)
        ownershipToken = ownership.keys().next().value
        const groups = ownership.get(ownershipToken)
        assert.equal(groups.size, 1)
        const groupId = groups.values().next().value
        try {
          const indexResponse = await fetch('http://127.0.0.1:5174/', {
            cache: 'no-store',
            headers: { Connection: 'close' },
            redirect: 'manual',
            signal: AbortSignal.timeout(2_000),
          })
          const indexBody = await indexResponse.text()
          const modulePath = [...indexBody.matchAll(
            /<script type="module" src="([^"]+)"><\/script>/g,
          )]
            .map((match) => match[1])
            .find((path) => path.endsWith('/src/main.jsx')) ?? ''
          const moduleResponse = modulePath
            ? await fetch(new URL(modulePath, READY_URL), {
                cache: 'no-store',
                headers: { Connection: 'close' },
                redirect: 'manual',
                signal: AbortSignal.timeout(2_000),
              })
            : null
          const moduleBody = moduleResponse ? await moduleResponse.text() : ''
          probe = Object.freeze({
            browserPath: modulePath.startsWith('/@fs/')
              && modulePath.endsWith('/src/main.jsx'),
            indexStatus: indexResponse.status,
            javascript: /javascript/i.test(
              moduleResponse?.headers.get('content-type') ?? '',
            ),
            leakedParentSecret: moduleBody.includes('must-not-reach-browser-module'),
            moduleStatus: moduleResponse?.status ?? null,
            pluginError: /Failed to resolve import|vite:import-analysis/.test(moduleBody),
            transformed: moduleBody.includes('jsxDEV'),
            transportFailed: false,
          })
        } catch {
          probe = Object.freeze({
            browserPath: false,
            indexStatus: null,
            javascript: false,
            leakedParentSecret: false,
            moduleStatus: null,
            pluginError: false,
            transformed: false,
            transportFailed: true,
          })
        } finally {
          process.kill(-groupId, 'SIGTERM')
        }
      },
    },
  })

  assert.deepEqual(probe, {
    browserPath: true,
    indexStatus: 200,
    javascript: true,
    leakedParentSecret: false,
    moduleStatus: 200,
    pluginError: false,
    transformed: true,
    transportFailed: false,
  })
  assert.deepEqual(result, { code: 'APP_E2E_RUNTIME_FAILED', ok: false })
  await waitForRunnerResourcesAbsent()
  assert.deepEqual(runnerTemporaryRoots(), temporaryRootsBefore)
})

test('default runner reports a natural post-ready Vite exit after complete cleanup', {
  skip: !SUPPORTED,
  timeout: 60_000,
}, async () => {
  await assertRunnerResourcesAbsent()
  let stoppedGroup = null
  let stoppedToken = null
  try {
    const result = await runAppE2E({
      argv: [],
      env: {},
      deps: {
        maxReadinessAttempts: 120,
        onReady: () => {
          const ownership = ownershipMarkerSnapshot()
          assert.equal(ownership.size, 1)
          stoppedToken = ownership.keys().next().value
          const groups = ownership.get(stoppedToken)
          assert.equal(groups.size, 1)
          stoppedGroup = groups.values().next().value
          process.kill(-stoppedGroup, 'SIGTERM')
        },
      },
    })
    assert.deepEqual(result, { code: 'APP_E2E_RUNTIME_FAILED', ok: false })
    await assertRunnerResourcesAbsent()
  } finally {
    if (stoppedToken) {
      const groups = ownershipMarkerSnapshot().get(stoppedToken) ?? new Set()
      for (const groupId of groups) {
        try { process.kill(-groupId, 'SIGKILL') } catch { /* Already absent. */ }
      }
    }
  }
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
    await assertRunnerResourcesAbsent()
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
