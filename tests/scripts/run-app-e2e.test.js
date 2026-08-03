import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createConnection, createServer } from 'node:net'
import * as appE2ERunner from '../../scripts/run-app-e2e.mjs'

const {
  assertReadySession,
  runBoundedAppChild,
  runAppE2E,
} = appE2ERunner
import { CAPABILITIES } from '../../worker/identity/policy.js'

const CSP = "default-src 'none'"
const READY_URL = 'http://127.0.0.1:5174/api/v1/session'
const NOW_MS = Date.parse('2028-01-01T00:00:00.000Z')
const CSRF_EXPIRES = Math.floor(NOW_MS / 1000) + 900
const CSRF_TOKEN = `v1.${CSRF_EXPIRES}.${'A'.repeat(22)}.${Buffer.alloc(32, 1).toString('base64url')}`
const key = (byte) => Buffer.alloc(32, byte).toString('base64url')
const STAGE_A_MIGRATION_NAMES = Object.freeze([
  '0001_security_primitives.sql',
  '0002_identity_operations.sql',
  '0003_rate_limit_guard.sql',
  '0004_staff_provisioning_state.sql',
  '0005_outbox_operation_guard.sql',
  '0006_delivery_attempt_uniqueness.sql',
  '0007_operational_health_indexes.sql',
  '0008_outbox_drain_heartbeat.sql',
  '0009_core_directory_expand.sql',
])

const fakeHarness = (path) => {
  const directory = (name) => ({ fence: {}, path: `${path}/${name}` })
  const file = (name) => ({ digest: 'a'.repeat(64), fence: {}, path: `${path}/${name}`, size: 1 })
  return {
    fence: {},
    home: directory('home'),
    index: file('vite-root/index.html'),
    migrations: directory('migrations'),
    path,
    state: directory('state'),
    tmp: directory('tmp'),
    vite: file('vite-root/vite.mjs'),
    viteRoot: directory('vite-root'),
    wrangler: file('wrangler.json'),
    xdgCache: directory('xdg-cache'),
    xdgConfig: directory('xdg-config'),
    xdgData: directory('xdg-data'),
  }
}

const fakeHarnessDeps = () => ({
  assertHarness: async () => true,
  assertListenerOwner: async () => 'owned-listener',
  assertPortAvailable: async () => true,
  assertRemoved: async () => true,
  externalArtifactSnapshot: async () => 'stable',
  prepareHarness: async (path) => fakeHarness(path),
  scanHarnessArtifacts: async () => true,
})

const managedRunnerFixture = ({
  firstProbeExitCode = null,
  listenerFailure = false,
  malformedChild = false,
  malformedOnce = false,
  missingKill = false,
  naturalCodeBeforeStop = null,
  naturalCodeOnStop = null,
  outputFailureAfterSecondProbe = false,
  outputFailureBeforeReady = false,
  outputFailureOnFirstProbe = false,
  ownershipFailure = false,
  persistentGroup = false,
  readinessFailure = false,
  registrationFailure = null,
  removalFailure = null,
  terminalDelayMs = 0,
  terminalErrorOnStop = false,
} = {}) => {
  const child = new EventEmitter()
  child.pid = 999_999_999
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  if (malformedChild) child.stderr = null
  child.kill = () => true
  if (registrationFailure === 'exit' || registrationFailure === 'close') {
    const once = child.once.bind(child)
    child.once = (event, listener) => {
      if (event === registrationFailure) {
        throw new Error('raw registration failure with secret-value')
      }
      return once(event, listener)
    }
  }
  if (registrationFailure === 'stdout') {
    child.stdout.on = () => {
      throw new Error('raw registration failure with secret-value')
    }
  }
  if (registrationFailure === 'stderr') {
    child.stderr.on = () => {
      throw new Error('raw registration failure with secret-value')
    }
  }
  if (removalFailure === 'stdout') {
    child.stdout.removeListener = () => {
      throw new Error('raw removal failure with secret-value')
    }
  }
  if (malformedOnce) child.once = null
  if (missingKill) child.kill = null
  const calls = []
  const removed = []
  const signals = new EventEmitter()
  let groupAlive = true
  let listenerChecks = 0
  let portChecks = 0
  const finishNaturally = (code = 2) => {
    groupAlive = false
    child.emit('exit', code, null)
  }
  return {
    child,
    calls,
    deps: {
      ...fakeHarnessDeps(),
      assertListenerOwner: async () => {
        listenerChecks += 1
        if (listenerChecks === 1 && Number.isInteger(firstProbeExitCode)) {
          groupAlive = false
          child.emit('exit', firstProbeExitCode, null)
          return null
        }
        if (listenerChecks === 1 && outputFailureOnFirstProbe) {
          child.stdout.emit('data', Buffer.alloc(65_537))
        }
        if (listenerChecks === 2 && Number.isInteger(naturalCodeBeforeStop)) {
          groupAlive = false
          child.emit('exit', naturalCodeBeforeStop, null)
        }
        if (listenerChecks === 2 && outputFailureBeforeReady) {
          child.stdout.emit('data', Buffer.alloc(65_537))
        }
        if (listenerChecks === 2 && outputFailureAfterSecondProbe) {
          queueMicrotask(() => {
            queueMicrotask(() => {
              queueMicrotask(() => {
                calls.push('queued-output')
                child.stdout.emit('data', Buffer.alloc(65_537))
              })
            })
          })
        }
        return 'owned-listener'
      },
      assertPortAvailable: async () => {
        portChecks += 1
        calls.push(`port:${portChecks}`)
        if (listenerFailure && portChecks === 3) {
          throw new Error('raw listener failure with secret-value')
        }
      },
      fetch: async () => {
        if (readinessFailure) throw new Error('fixed fixture readiness failure')
        return readyResponse()
      },
      makePersistenceDirectory: async () => '/tmp/bwm-managed-runner',
      prepareHarness: async (path) => ({
        ...fakeHarness(path),
        viteRoot: {
          fence: {},
          path: process.cwd(),
        },
      }),
      managedChildDeps: {
        groupExistsImpl: () => groupAlive,
        ownedGroupsImpl: (pid) => {
          if (ownershipFailure) {
            throw new Error('raw ownership failure with secret-value')
          }
          return [pid]
        },
        signalGroupImpl: (_groupId, signal) => {
          calls.push(`signal:${signal}`)
          if (persistentGroup) return
          if (!groupAlive) return
          if (Number.isInteger(naturalCodeOnStop)) {
            child.emit('exit', naturalCodeOnStop, null)
          }
          if (terminalErrorOnStop) {
            child.emit('error', new Error('raw child failure with secret-value'))
          }
          groupAlive = false
          if (terminalDelayMs > 0) {
            setTimeout(() => child.emit('exit', null, signal), terminalDelayMs)
          } else {
            queueMicrotask(() => child.emit('exit', null, signal))
          }
        },
        sleep: terminalDelayMs > 0
          ? (milliseconds) => new Promise((resolve) => {
            setTimeout(resolve, Math.min(milliseconds, 1))
          })
          : async () => {},
        spawnImpl: (_command, _args, options) => {
          calls.push('spawn')
          const markerNames = Object.keys(options.env).filter((name) => (
            name.startsWith('BWM_APP_E2E_')
          ))
          assert.deepEqual(markerNames, ['BWM_APP_E2E_OWNERSHIP'])
          assert.match(options.env.BWM_APP_E2E_OWNERSHIP, /^[a-f0-9]{48}$/)
          return child
        },
      },
      now: () => NOW_MS,
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      removePersistenceDirectory: async (path) => removed.push(path),
      runChild: async (input) => ({
        code: 0,
        stderr: '',
        stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
          ? 'SEED_LOCAL_COMPLETE\n'
          : '',
      }),
      signals,
    },
    finishNaturally,
    groupAlive: () => groupAlive,
    portChecks: () => portChecks,
    removed,
    signals,
  }
}

const readyResponse = (overrides = {}) => {
  const response = new Response(overrides.rawBody ?? JSON.stringify({
  data: {
    actor: {
      id: 'stf_local_owner',
      displayName: 'Alicja Testowa',
      role: 'owner',
      specialistId: null,
    },
    capabilities: [...CAPABILITIES],
    csrfToken: CSRF_TOKEN,
    csrfExpiresAt: new Date(CSRF_EXPIRES * 1000).toISOString(),
    environment: 'development',
    dataMode: 'fictional',
    ...(overrides.body ?? {}),
  },
  }), {
  status: overrides.status ?? 200,
  headers: {
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'content-type': 'application/json',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...(overrides.headers ?? {}),
  },
})
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: overrides.url ?? READY_URL,
  })
  return response
}

test('readiness accepts only the exact loopback session, security headers, and seeded owner', async () => {
  const result = await assertReadySession(readyResponse(), {
    nowMs: NOW_MS,
  })
  assert.equal(result.actorId, 'stf_local_owner')
  assert.equal(result.environment, 'development')

  for (const response of [
    readyResponse({ status: 302 }),
    readyResponse({ url: 'http://localhost:5174/api/v1/session' }),
    readyResponse({ headers: { 'cache-control': 'public, max-age=60' } }),
    readyResponse({ headers: { 'x-content-type-options': 'wrong' } }),
    readyResponse({ headers: { 'referrer-policy': 'origin' } }),
    readyResponse({ headers: { 'content-security-policy': "default-src 'self'" } }),
    readyResponse({ headers: { 'content-type': 'application/jsonp' } }),
    readyResponse({ body: { environment: 'staging' } }),
    readyResponse({ body: { dataMode: 'real' } }),
    readyResponse({ body: { capabilities: ['staff.manage'] } }),
    readyResponse({ body: { actor: { id: 'stf_other', displayName: 'Other', role: 'owner', specialistId: null } } }),
    readyResponse({ body: { csrfExpiresAt: '2020-01-01T00:00:00.000Z' } }),
    readyResponse({ body: { csrfExpiresAt: 'not-a-date' } }),
    readyResponse({ body: { csrfToken: 'v1.invalid' } }),
    readyResponse({
      body: {
        csrfToken: `v1.${CSRF_EXPIRES + 1}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      },
    }),
    readyResponse({
      rawBody: `${JSON.stringify({
        data: {
          actor: {
            id: 'stf_local_owner',
            displayName: 'Alicja Testowa',
            role: 'owner',
            specialistId: null,
          },
          capabilities: [...CAPABILITIES],
          csrfToken: CSRF_TOKEN,
          csrfExpiresAt: new Date(CSRF_EXPIRES * 1000).toISOString(),
          environment: 'development',
          dataMode: 'fictional',
        },
      })}${' '.repeat(20_000)}`,
    }),
  ]) {
    await assert.rejects(
      assertReadySession(response, { nowMs: NOW_MS }),
      /^Error: APP_E2E_READINESS_INVALID$/,
    )
  }
})

test('readiness rejects a response body that stops yielding', { timeout: 100 }, async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":'))
    },
  }), {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': CSP,
      'content-type': 'application/json',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: READY_URL,
  })

  await assert.rejects(
    assertReadySession(response, {
      bodyDeadlineMs: 10,
      nowMs: NOW_MS,
    }),
    /^Error: APP_E2E_READINESS_INVALID$/,
  )
})

test('runner applies migrations, seeds, then starts exact loopback Vite with one shared path', async () => {
  const calls = []
  const signals = new EventEmitter()
  const vite = new EventEmitter()
  vite.pid = 42
  vite.kill = (signal) => {
    calls.push({ kind: 'kill', signal })
    queueMicrotask(() => vite.emit('exit', 0, signal))
    return true
  }
  const result = await runAppE2E({
    argv: [],
    env: {
      HOME: '/safe/home',
      PATH: '/safe/bin',
      SENTINEL_PARENT_SECRET: 'must-not-leak',
      CF_API_TOKEN: 'must-not-leak-either',
    },
    deps: {
      ...fakeHarnessDeps(),
      assertListenerOwner: async () => {
        calls.push({ kind: 'owner' })
        return 'owned-listener'
      },
      assertPortAvailable: async () => calls.push({ kind: 'port' }),
      makePersistenceDirectory: async () => '/tmp/bwm-runner-owned',
      removePersistenceDirectory: async (path) => calls.push({ kind: 'remove', path }),
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      runChild: async (input) => {
        calls.push({ kind: 'run', ...input })
        return {
          code: 0,
          stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
            ? 'SEED_LOCAL_COMPLETE\n'
            : '',
          stderr: '',
        }
      },
      startChild: (input) => {
        calls.push({ kind: 'start', ...input })
        return vite
      },
      fetch: async (url, init) => {
        calls.push({ kind: 'fetch', url, init })
        return readyResponse()
      },
      sleep: async () => {},
      signals,
      now: () => Date.parse('2028-01-01T00:00:00.000Z'),
      exitAfterReady: true,
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_READY', ok: true })
  const runs = calls.filter(({ kind }) => kind === 'run')
  assert.equal(runs.length, 2)
  assert.match(runs[0].args.join(' '), /d1 migrations apply DB --local/)
  assert.deepEqual(
    runs[0].args.slice(-2),
    ['--persist-to', '/tmp/bwm-runner-owned/state'],
  )
  assert.deepEqual(runs[0].args.slice(1, 7), [
    '--config',
    '/tmp/bwm-runner-owned/wrangler.json',
    '--x-provision=false',
    '--x-auto-create=false',
    '--install-skills=false',
    'd1',
  ])
  assert.match(runs[1].args.join(' '), /scripts\/seed-local\.mjs/)
  assert.equal(runs[1].env.BWM_LOCAL_PERSISTENCE_PATH, '/tmp/bwm-runner-owned/state')
  assert.equal(runs[1].env.BWM_LOCAL_RUNNER_MODE, 'runner-v1')
  const start = calls.find(({ kind }) => kind === 'start')
  assert.ok(start)
  assert.deepEqual(start.args.slice(1), [
    '--config',
    '/tmp/bwm-runner-owned/vite-root/vite.mjs',
    '--configLoader',
    'native',
    '--logLevel',
    'silent',
    '--clearScreen=false',
    '--mode',
    'app',
    '--host',
    '127.0.0.1',
    '--port',
    '5174',
    '--strictPort',
  ])
  assert.equal(start.cwd, '/tmp/bwm-runner-owned/vite-root')
  assert.equal(Object.hasOwn(start.env, 'BWM_LOCAL_PERSISTENCE_PATH'), false)
  assert.equal(Object.hasOwn(start.env, 'SENTINEL_PARENT_SECRET'), false)
  assert.equal(Object.hasOwn(start.env, 'CF_API_TOKEN'), false)
  assert.equal(Object.hasOwn(start.env, 'PATH'), false)
  assert.equal(start.env.NODE_DISABLE_COMPILE_CACHE, '1')
  const fetch = calls.find(({ kind }) => kind === 'fetch')
  assert.equal(fetch.url, 'http://127.0.0.1:5174/api/v1/session')
  assert.equal(fetch.init.cache, 'no-store')
  assert.deepEqual(fetch.init.headers, { 'X-BWM-Local-Identity': 'owner@example.test' })
  assert.equal(fetch.init.redirect, 'manual')
  assert.equal(fetch.init.signal instanceof AbortSignal, true)
  assert.equal(calls.filter(({ kind }) => kind === 'owner').length, 2)
  assert.equal(calls.filter(({ kind }) => kind === 'port').length, 3)
  assert.deepEqual(calls.filter(({ kind }) => kind === 'remove'), [
    { kind: 'remove', path: '/tmp/bwm-runner-owned' },
  ])
})

test('runner remains live after readiness and handles a later signal before cleanup', {
  timeout: 1_000,
}, async () => {
  const calls = []
  const signals = new EventEmitter()
  const vite = new EventEmitter()
  vite.pid = 42
  vite.kill = (signal) => {
    calls.push(`kill:${signal}`)
    queueMicrotask(() => vite.emit('exit', null, signal))
    return true
  }
  let notifyReady
  const ready = new Promise((resolve) => {
    notifyReady = resolve
  })
  let settled = false
  const running = runAppE2E({
    argv: [],
    env: {},
    deps: {
      ...fakeHarnessDeps(),
      fetch: async () => readyResponse(),
      makePersistenceDirectory: async () => '/tmp/bwm-runtime-signal',
      now: () => NOW_MS,
      onReady: () => {
        calls.push('ready')
        assert.equal(signals.listenerCount('SIGINT'), 1)
        assert.equal(signals.listenerCount('SIGTERM'), 1)
        notifyReady()
      },
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      removePersistenceDirectory: async (path) => calls.push(`remove:${path}`),
      runChild: async (input) => ({
        code: 0,
        stderr: '',
        stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
          ? 'SEED_LOCAL_COMPLETE\n'
          : '',
      }),
      signals,
      startChild: () => vite,
    },
  })
  running.finally(() => {
    settled = true
  })

  await ready
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.deepEqual(calls, ['ready'])

  signals.emit('SIGINT')
  signals.emit('SIGTERM')
  const result = await running

  assert.deepEqual(result, { code: 'APP_E2E_INTERRUPTED', ok: false })
  assert.deepEqual(calls, [
    'ready',
    'kill:SIGINT',
    'remove:/tmp/bwm-runtime-signal',
  ])
  assert.equal(signals.listenerCount('SIGINT'), 0)
  assert.equal(signals.listenerCount('SIGTERM'), 0)
})

test('runner reports a natural Vite exit after readiness as a runtime failure', {
  timeout: 1_000,
}, async () => {
  const calls = []
  const signals = new EventEmitter()
  const vite = new EventEmitter()
  vite.pid = 42
  vite.kill = (signal) => {
    calls.push(`kill:${signal}`)
    return true
  }
  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: {
      ...fakeHarnessDeps(),
      fetch: async () => readyResponse(),
      makePersistenceDirectory: async () => '/tmp/bwm-runtime-exit',
      now: () => NOW_MS,
      onReady: () => {
        calls.push('ready')
        queueMicrotask(() => vite.emit('exit', 2, null))
      },
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      removePersistenceDirectory: async (path) => calls.push(`remove:${path}`),
      runChild: async (input) => ({
        code: 0,
        stderr: '',
        stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
          ? 'SEED_LOCAL_COMPLETE\n'
          : '',
      }),
      signals,
      startChild: () => vite,
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_RUNTIME_FAILED', ok: false })
  assert.deepEqual(calls, [
    'ready',
    'remove:/tmp/bwm-runtime-exit',
  ])
  assert.equal(signals.listenerCount('SIGINT'), 0)
  assert.equal(signals.listenerCount('SIGTERM'), 0)
})

for (const [label, configure, expected] of [
  [
    'exitAfterReady',
    (fixture) => {
      fixture.deps.exitAfterReady = true
    },
    { code: 'APP_E2E_READY', ok: true },
  ],
  [
    'natural post-ready exit',
    (fixture) => {
      fixture.deps.onReady = () => {
        queueMicrotask(() => fixture.finishNaturally(2))
      }
    },
    { code: 'APP_E2E_RUNTIME_FAILED', ok: false },
  ],
  [
    'SIGINT',
    (fixture) => {
      fixture.deps.onReady = () => {
        queueMicrotask(() => fixture.signals.emit('SIGINT'))
      }
    },
    { code: 'APP_E2E_INTERRUPTED', ok: false },
  ],
]) {
  test(`production managed runner ${label} proves process and port absence`, {
    timeout: 1_000,
  }, async () => {
    assert.equal(typeof appE2ERunner.startManagedAppE2EChild, 'function')
    assert.equal(typeof appE2ERunner.waitForManagedAppE2EChild, 'function')
    const fixture = managedRunnerFixture()
    configure(fixture)

    const result = await runAppE2E({
      argv: [],
      env: {},
      deps: fixture.deps,
    })

    assert.deepEqual(result, expected)
    assert.equal(fixture.groupAlive(), false)
    assert.equal(fixture.portChecks(), 3)
    assert.deepEqual(fixture.removed, ['/tmp/bwm-managed-runner'])
    assert.equal(fixture.child.listenerCount('error'), 0)
    assert.equal(fixture.child.listenerCount('exit'), 0)
    assert.equal(fixture.child.listenerCount('close'), 0)
    assert.equal(fixture.child.stdout.listenerCount('data'), 0)
    assert.equal(fixture.child.stderr.listenerCount('data'), 0)
    assert.equal(fixture.signals.listenerCount('SIGINT'), 0)
    assert.equal(fixture.signals.listenerCount('SIGTERM'), 0)
  })
}

test('production managed runner never reports ready after a managed stop error', async () => {
  assert.equal(typeof appE2ERunner.startManagedAppE2EChild, 'function')
  const fixture = managedRunnerFixture({ terminalErrorOnStop: true })
  fixture.deps.exitAfterReady = true

  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: fixture.deps,
  })

  assert.deepEqual(result, { code: 'APP_E2E_RUNTIME_FAILED', ok: false })
  assert.equal(JSON.stringify(result).includes('secret-value'), false)
  assert.equal(fixture.groupAlive(), false)
  assert.equal(fixture.portChecks(), 3)
  assert.deepEqual(fixture.removed, ['/tmp/bwm-managed-runner'])
})

test('production managed runner never reports ready after a racing nonzero exit', async () => {
  assert.equal(typeof appE2ERunner.startManagedAppE2EChild, 'function')
  const fixture = managedRunnerFixture({ naturalCodeOnStop: 2 })
  fixture.deps.exitAfterReady = true

  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: fixture.deps,
  })

  assert.deepEqual(result, { code: 'APP_E2E_RUNTIME_FAILED', ok: false })
  assert.equal(fixture.groupAlive(), false)
  assert.equal(fixture.portChecks(), 3)
  assert.deepEqual(fixture.removed, ['/tmp/bwm-managed-runner'])
})

test('production managed runner classifies an exit during the second readiness ownership check as pre-ready', async () => {
  assert.equal(typeof appE2ERunner.startManagedAppE2EChild, 'function')
  const fixture = managedRunnerFixture({ naturalCodeBeforeStop: 0 })
  let readyCalls = 0
  fixture.deps.maxReadinessAttempts = 1
  fixture.deps.onReady = () => {
    readyCalls += 1
    fixture.calls.push('ready')
  }

  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: fixture.deps,
  })

  assert.deepEqual(result, { code: 'APP_E2E_CHILD_EXITED', ok: false })
  assert.equal(readyCalls, 0)
  assert.equal(fixture.groupAlive(), false)
  assert.equal(fixture.portChecks(), 3)
  assert.deepEqual(fixture.removed, ['/tmp/bwm-managed-runner'])
})

test('production managed runner classifies output overflow during the second ownership check as pre-ready', async () => {
  assert.equal(typeof appE2ERunner.startManagedAppE2EChild, 'function')
  const fixture = managedRunnerFixture({ outputFailureBeforeReady: true })
  let readyCalls = 0
  fixture.deps.maxReadinessAttempts = 1
  fixture.deps.onReady = () => {
    readyCalls += 1
  }

  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: fixture.deps,
  })

  assert.deepEqual(result, { code: 'APP_E2E_START_FAILED', ok: false })
  assert.equal(readyCalls, 0)
  assert.equal(fixture.groupAlive(), false)
  assert.equal(fixture.portChecks(), 3)
  assert.deepEqual(fixture.removed, ['/tmp/bwm-managed-runner'])
})

test('production managed runner does not yield after a clean shutdown-latch probe', async () => {
  assert.equal(typeof appE2ERunner.startManagedAppE2EChild, 'function')
  const fixture = managedRunnerFixture({ outputFailureAfterSecondProbe: true })
  let readyCalls = 0
  fixture.deps.maxReadinessAttempts = 1
  fixture.deps.onReady = () => {
    readyCalls += 1
    fixture.calls.push('ready')
  }

  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: fixture.deps,
  })

  assert.deepEqual(result, { code: 'APP_E2E_RUNTIME_FAILED', ok: false })
  assert.equal(readyCalls, 1)
  assert.ok(fixture.calls.indexOf('ready') < fixture.calls.indexOf('queued-output'))
  assert.equal(fixture.groupAlive(), false)
  assert.equal(fixture.portChecks(), 3)
  assert.deepEqual(fixture.removed, ['/tmp/bwm-managed-runner'])
})

test('production managed runner classifies an exit during a failed first ownership check as pre-ready', async () => {
  assert.equal(typeof appE2ERunner.startManagedAppE2EChild, 'function')
  const fixture = managedRunnerFixture({ firstProbeExitCode: 0 })
  let readyCalls = 0
  fixture.deps.maxReadinessAttempts = 1
  fixture.deps.onReady = () => {
    readyCalls += 1
  }

  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: fixture.deps,
  })

  assert.deepEqual(result, { code: 'APP_E2E_CHILD_EXITED', ok: false })
  assert.equal(readyCalls, 0)
  assert.equal(fixture.groupAlive(), false)
  assert.equal(fixture.portChecks(), 3)
  assert.deepEqual(fixture.removed, ['/tmp/bwm-managed-runner'])
})

test('production managed runner classifies output failure before a failed readiness fetch as pre-ready', async () => {
  assert.equal(typeof appE2ERunner.startManagedAppE2EChild, 'function')
  const fixture = managedRunnerFixture({
    outputFailureOnFirstProbe: true,
    readinessFailure: true,
    terminalDelayMs: 5,
  })
  let readyCalls = 0
  fixture.deps.maxReadinessAttempts = 1
  fixture.deps.onReady = () => {
    readyCalls += 1
  }

  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: fixture.deps,
  })

  assert.deepEqual(result, { code: 'APP_E2E_START_FAILED', ok: false })
  assert.equal(readyCalls, 0)
  assert.equal(fixture.groupAlive(), false)
  assert.equal(fixture.portChecks(), 3)
  assert.deepEqual(fixture.removed, ['/tmp/bwm-managed-runner'])
})

for (const boundary of ['exit', 'close', 'stdout', 'stderr']) {
  test(`production managed runner classifies ${boundary} registration failure as startup failure`, async () => {
    assert.equal(typeof appE2ERunner.startManagedAppE2EChild, 'function')
    const fixture = managedRunnerFixture({ registrationFailure: boundary })

    const result = await runAppE2E({
      argv: [],
      env: {},
      deps: fixture.deps,
    })

    assert.deepEqual(result, { code: 'APP_E2E_START_FAILED', ok: false })
    assert.equal(JSON.stringify(result).includes('secret-value'), false)
    assert.equal(fixture.groupAlive(), false)
    assert.equal(fixture.portChecks(), 3)
    assert.deepEqual(fixture.removed, ['/tmp/bwm-managed-runner'])
    assert.equal(fixture.child.listenerCount('error'), 0)
    assert.equal(fixture.child.listenerCount('exit'), 0)
    assert.equal(fixture.child.listenerCount('close'), 0)
  })
}

for (const [label, fixtureOptions] of [
  ['listener absence proof fails', { listenerFailure: true }],
  ['ownership absence proof fails', { ownershipFailure: true }],
  [
    'a malformed positive-PID child remains observable',
    { malformedChild: true, persistentGroup: true },
  ],
  [
    'a positive-PID child has no callable once method',
    { malformedOnce: true, persistentGroup: true },
  ],
  [
    'a positive-PID child has no callable kill method',
    { missingKill: true, persistentGroup: true },
  ],
  [
    'a managed listener removal callback fails',
    { removalFailure: 'stdout' },
  ],
]) {
  test(`production managed runner preserves its harness when ${label}`, {
    timeout: 1_000,
  }, async () => {
    assert.equal(typeof appE2ERunner.startManagedAppE2EChild, 'function')
    assert.equal(typeof appE2ERunner.waitForManagedAppE2EChild, 'function')
    const fixture = managedRunnerFixture(fixtureOptions)
    fixture.deps.exitAfterReady = true

    const result = await runAppE2E({
      argv: [],
      env: {},
      deps: fixture.deps,
    })

    assert.deepEqual(result, { code: 'APP_E2E_SHUTDOWN_FAILED', ok: false })
    assert.equal(JSON.stringify(result).includes('secret-value'), false)
    assert.deepEqual(fixture.removed, [])
    assert.equal(fixture.signals.listenerCount('SIGINT'), 0)
    assert.equal(fixture.signals.listenerCount('SIGTERM'), 0)
  })
}

test('runner forwards only the first termination signal and cleans up an owned directory', async () => {
  const calls = []
  const signals = new EventEmitter()
  const vite = new EventEmitter()
  vite.pid = 42
  vite.kill = (signal) => {
    calls.push(signal)
    queueMicrotask(() => vite.emit('exit', null, signal))
    return true
  }
  let releaseFetch
  const running = runAppE2E({
    argv: [],
    env: { HOME: '/safe/home', PATH: '/safe/bin' },
    deps: {
      ...fakeHarnessDeps(),
      makePersistenceDirectory: async () => '/tmp/bwm-signal-owned',
      removePersistenceDirectory: async (path) => calls.push(`remove:${path}`),
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      runChild: async (input) => ({
        code: 0,
        stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
          ? 'SEED_LOCAL_COMPLETE\n'
          : '',
        stderr: '',
      }),
      startChild: () => vite,
      fetch: async () => new Promise((resolve) => {
        releaseFetch = resolve
      }),
      sleep: async () => {},
      signals,
      now: Date.now,
    },
  })
  while (!releaseFetch) await new Promise((resolve) => setImmediate(resolve))
  signals.emit('SIGINT')
  signals.emit('SIGTERM')
  releaseFetch(readyResponse())
  const result = await running

  assert.deepEqual(calls, ['SIGINT', 'remove:/tmp/bwm-signal-owned'])
  assert.deepEqual(result, { code: 'APP_E2E_INTERRUPTED', ok: false })
})

test('runner forbids later preparation or mutation after a startup signal', async () => {
  for (const signalAt of ['make', 'prepare']) {
    const calls = []
    const signals = new EventEmitter()
    const path = `/tmp/bwm-signal-${signalAt}`
    const result = await runAppE2E({
      argv: [],
      env: {},
      deps: {
        ...fakeHarnessDeps(),
        assertHarness: async () => calls.push('assert'),
        makePersistenceDirectory: async () => {
          calls.push('make')
          if (signalAt === 'make') signals.emit('SIGINT')
          return path
        },
        prepareHarness: async () => {
          calls.push('prepare')
          if (signalAt === 'prepare') signals.emit('SIGINT')
          return fakeHarness(path)
        },
        removePersistenceDirectory: async () => calls.push('remove'),
        runChild: async () => {
          calls.push('run')
          return { code: 0, stderr: '', stdout: '' }
        },
        signals,
      },
    })

    assert.deepEqual(result, { code: 'APP_E2E_INTERRUPTED', ok: false })
    assert.equal(calls.includes('run'), false)
    assert.equal(calls.includes('assert'), signalAt === 'prepare')
    assert.equal(calls.includes('prepare'), signalAt === 'prepare')
    assert.equal(calls.at(-1), 'remove')
  }
})

test('runner interruption kills a stubborn inherited seed descendant before cleanup', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
  timeout: 5_000,
}, async () => {
  const signals = new EventEmitter()
  const removed = []
  let fixturePid
  let runs = 0
  const leaderSource = `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e',
      "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    child.once('message', () => process.stdout.write('READY\\\\n'))
    setInterval(() => {}, 1000)
  `
  try {
    const result = await runAppE2E({
      argv: [],
      env: {},
      deps: {
        ...fakeHarnessDeps(),
        makePersistenceDirectory: async () => '/tmp/bwm-real-interrupt',
        randomKey: (() => {
          let byte = 1
          return () => key(byte++)
        })(),
        removePersistenceDirectory: async (path) => removed.push(path),
        runChild: async (input, callbacks) => {
          runs += 1
          if (runs === 1) return { code: 0, stderr: '', stdout: '' }
          return runBoundedAppChild({
            args: ['-e', leaderSource],
            command: realpathSync(process.execPath),
            cwd: realpathSync(process.cwd()),
            env: {},
            shell: false,
          }, {
            deadlineMs: 4_000,
            onRetainedChunk: (chunk, stream) => {
              if (stream === 'stdout' && chunk.toString('utf8').includes('READY')) {
                queueMicrotask(() => {
                  signals.emit('SIGINT')
                  signals.emit('SIGTERM')
                })
              }
            },
            onSettled: callbacks.onSettled,
            onSpawn: (child) => {
              fixturePid = child.pid
              callbacks.onSpawn(child)
            },
          })
        },
        signals,
      },
    })

    assert.deepEqual(result, { code: 'APP_E2E_INTERRUPTED', ok: false })
    assert.deepEqual(removed, ['/tmp/bwm-real-interrupt'])
    assert.throws(
      () => process.kill(-fixturePid, 0),
      (error) => error?.code === 'ESRCH',
    )
  } finally {
    if (fixturePid) {
      try { process.kill(-fixturePid, 'SIGKILL') } catch { /* Already absent. */ }
    }
  }
})

test('runner seed-stage deadline kills a pipe-holding descendant and forbids Vite', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
  timeout: 3_000,
}, async () => {
  const removed = []
  let fixturePid
  let runs = 0
  let starts = 0
  const leaderSource = `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"
    ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child.once('message', () => {
      process.stdout.write('READY\\\\n')
      setTimeout(() => process.exit(1), 25)
    })
    setInterval(() => {}, 1000)
  `
  try {
    const result = await runAppE2E({
      argv: [],
      env: {},
      deps: {
        ...fakeHarnessDeps(),
        makePersistenceDirectory: async () => '/tmp/bwm-real-deadline',
        randomKey: (() => {
          let byte = 1
          return () => key(byte++)
        })(),
        removePersistenceDirectory: async (path) => removed.push(path),
        runChild: async (input, callbacks) => {
          runs += 1
          if (runs === 1) return { code: 0, stderr: '', stdout: '' }
          return runBoundedAppChild({
            args: ['-e', leaderSource],
            command: realpathSync(process.execPath),
            cwd: realpathSync(process.cwd()),
            env: {},
            shell: false,
          }, {
            deadlineMs: 300,
            onSettled: callbacks.onSettled,
            onSpawn: (child) => {
              fixturePid = child.pid
              callbacks.onSpawn(child)
            },
          })
        },
        signals: new EventEmitter(),
        startChild: () => {
          starts += 1
        },
      },
    })

    assert.deepEqual(result, { code: 'APP_E2E_SEED_FAILED', ok: false })
    assert.equal(starts, 0)
    assert.deepEqual(removed, ['/tmp/bwm-real-deadline'])
    assert.throws(
      () => process.kill(-fixturePid, 0),
      (error) => error?.code === 'ESRCH',
    )
  } finally {
    if (fixturePid) {
      try { process.kill(-fixturePid, 'SIGKILL') } catch { /* Already absent. */ }
    }
  }
})

test('runner refuses an occupied fixed port before migration or seed mutation', async () => {
  const calls = []
  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: {
      assertPortAvailable: async () => {
        calls.push('port')
        throw new Error('occupied details')
      },
      assertHarness: async () => true,
      externalArtifactSnapshot: async () => 'stable',
      makePersistenceDirectory: async () => '/tmp/bwm-occupied-owned',
      prepareHarness: async (path) => fakeHarness(path),
      removePersistenceDirectory: async (path) => calls.push(`remove:${path}`),
      runChild: async () => {
        calls.push('run')
        return { code: 0, stderr: '', stdout: '' }
      },
      scanHarnessArtifacts: async () => true,
      signals: new EventEmitter(),
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_PORT_OCCUPIED', ok: false })
  assert.deepEqual(calls, [
    'port',
    'remove:/tmp/bwm-occupied-owned',
  ])
})

test('fixed port proof destroys a held loopback connection and settles boundedly', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
  timeout: 1_000,
}, async () => {
  assert.equal(typeof appE2ERunner.probeAppE2EPort, 'function')
  let socket = null
  try {
    const result = await appE2ERunner.probeAppE2EPort({
      onListening: () => new Promise((resolve, reject) => {
        socket = createConnection({
          host: '127.0.0.1',
          port: 5174,
        })
        socket.once('connect', resolve)
        socket.once('error', () => reject(new Error('loopback probe connection failed')))
      }),
    })
    assert.equal(result, true)
  } finally {
    socket?.destroy()
  }
})

test('fixed port proof bounds a stalled listening callback and releases the port', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
  timeout: 1_000,
}, async () => {
  await assert.rejects(
    appE2ERunner.probeAppE2EPort({ onListening: null }),
    /^Error: APP_E2E_PORT_OCCUPIED$/,
  )
  await assert.rejects(
    appE2ERunner.probeAppE2EPort({
      onListening: () => new Promise(() => {}),
    }),
    /^Error: APP_E2E_PORT_OCCUPIED$/,
  )
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({
      exclusive: true,
      host: '127.0.0.1',
      port: 5174,
    }, resolve)
  })
  await new Promise((resolve) => server.close(resolve))
})

test('default port preflight rejects an IPv6 loopback listener before mutation', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async (t) => {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '::1', port: 5174 }, resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  let runs = 0
  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: {
      externalArtifactSnapshot: async () => 'stable',
      runChild: async () => {
        runs += 1
        return { code: 1, stderr: '', stdout: '' }
      },
      signals: new EventEmitter(),
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_PORT_OCCUPIED', ok: false })
  assert.equal(runs, 0)
})

test('runner rejects duplicate generated keys before migration', async () => {
  let runs = 0
  const removed = []
  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: {
      ...fakeHarnessDeps(),
      makePersistenceDirectory: async () => '/tmp/bwm-duplicate-keys',
      randomKey: () => key(1),
      removePersistenceDirectory: async (path) => removed.push(path),
      runChild: async () => {
        runs += 1
        return { code: 0, stderr: '', stdout: '' }
      },
      signals: new EventEmitter(),
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_START_FAILED', ok: false })
  assert.equal(runs, 0)
  assert.deepEqual(removed, ['/tmp/bwm-duplicate-keys'])
})

test('runner requires the exact fresh local-seed status before starting Vite', async () => {
  let runs = 0
  let starts = 0
  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: {
      ...fakeHarnessDeps(),
      makePersistenceDirectory: async () => '/tmp/bwm-seed-status',
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      removePersistenceDirectory: async () => {},
      runChild: async () => {
        runs += 1
        return {
          code: 0,
          stderr: '',
          stdout: runs === 2 ? 'SEED_LOCAL_ALREADY_COMPLETE\n' : '',
        }
      },
      signals: new EventEmitter(),
      startChild: () => {
        starts += 1
      },
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_SEED_FAILED', ok: false })
  assert.equal(starts, 0)
})

test('runner reports artifact leaks but still removes its owned root', async () => {
  const removed = []
  const vite = new EventEmitter()
  vite.pid = 42
  vite.kill = (signal) => {
    queueMicrotask(() => vite.emit('exit', 0, signal))
    return true
  }
  const result = await runAppE2E({
    argv: [],
    env: { SENTINEL_PARENT_SECRET: 'must-not-persist' },
    deps: {
      ...fakeHarnessDeps(),
      makePersistenceDirectory: async () => '/tmp/bwm-artifact-leak',
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      removePersistenceDirectory: async (path) => removed.push(path),
      runChild: async (input) => ({
        code: 0,
        stderr: '',
        stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
          ? 'SEED_LOCAL_COMPLETE\n'
          : '',
      }),
      scanHarnessArtifacts: async () => {
        throw new Error('sensitive matched bytes')
      },
      signals: new EventEmitter(),
      startChild: () => vite,
      fetch: async () => readyResponse(),
      now: () => NOW_MS,
      exitAfterReady: true,
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_ARTIFACT_LEAK', ok: false })
  assert.deepEqual(removed, ['/tmp/bwm-artifact-leak'])
  assert.doesNotMatch(JSON.stringify(result), /sensitive/)
})

test('runner reports writes outside its owned root after orderly shutdown', async () => {
  let snapshots = 0
  const vite = new EventEmitter()
  vite.pid = 42
  vite.kill = (signal) => {
    queueMicrotask(() => vite.emit('exit', 0, signal))
    return true
  }
  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: {
      ...fakeHarnessDeps(),
      externalArtifactSnapshot: async () => `snapshot-${snapshots++}`,
      makePersistenceDirectory: async () => '/tmp/bwm-external-write',
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      removePersistenceDirectory: async () => {},
      runChild: async (input) => ({
        code: 0,
        stderr: '',
        stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
          ? 'SEED_LOCAL_COMPLETE\n'
          : '',
      }),
      signals: new EventEmitter(),
      startChild: () => vite,
      fetch: async () => readyResponse(),
      now: () => NOW_MS,
      exitAfterReady: true,
    },
  })

  assert.deepEqual(result, {
    code: 'APP_E2E_EXTERNAL_ARTIFACT_CHANGED',
    ok: false,
  })
})

test('runner reports cleanup failure when removal returns without absence proof', async () => {
  const vite = new EventEmitter()
  vite.pid = 42
  vite.kill = (signal) => {
    queueMicrotask(() => vite.emit('exit', 0, signal))
    return true
  }
  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: {
      ...fakeHarnessDeps(),
      assertRemoved: async () => {
        throw new Error('root still exists')
      },
      makePersistenceDirectory: async () => '/tmp/bwm-removal-noop',
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      removePersistenceDirectory: async () => {},
      runChild: async (input) => ({
        code: 0,
        stderr: '',
        stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
          ? 'SEED_LOCAL_COMPLETE\n'
          : '',
      }),
      signals: new EventEmitter(),
      startChild: () => vite,
      fetch: async () => readyResponse(),
      now: () => NOW_MS,
      exitAfterReady: true,
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_CLEANUP_FAILED', ok: false })
})

test('runner rejects an in-place private-config rewrite before the next spawn', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async () => {
  let ownedRoot
  let runs = 0
  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: {
      assertPortAvailable: async () => true,
      externalArtifactSnapshot: async () => 'stable',
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      runChild: async (input) => {
        runs += 1
        const configPath = input.args[input.args.indexOf('--config') + 1]
        ownedRoot = configPath.slice(0, configPath.lastIndexOf('/'))
        const bytes = readFileSync(configPath)
        bytes[0] ^= 1
        writeFileSync(configPath, bytes, { flag: 'r+' })
        return { code: 0, stderr: '', stdout: '' }
      },
      signals: new EventEmitter(),
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_START_FAILED', ok: false })
  assert.equal(runs, 1)
  assert.equal(existsSync(ownedRoot), false)
})

test('default harness writes only credential-free private configs with separated roots', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async () => {
  const generatedKeys = [key(1), key(2), key(3)]
  let ownedRoot
  const result = await runAppE2E({
    argv: [],
    env: {
      CF_API_TOKEN: 'parent-cloud-token-sentinel',
      SENTINEL_PARENT_SECRET: 'parent-secret-sentinel',
    },
    deps: {
      assertPortAvailable: async () => true,
      externalArtifactSnapshot: async () => 'stable',
      randomKey: () => generatedKeys.shift(),
      runChild: async (input) => {
        const configPath = input.args[input.args.indexOf('--config') + 1]
        ownedRoot = configPath.slice(0, configPath.lastIndexOf('/'))
        const viteRoot = `${ownedRoot}/vite-root`
        const state = `${ownedRoot}/state`
        const wrangler = readFileSync(configPath, 'utf8')
        const vite = readFileSync(`${viteRoot}/.bwm-harness-vite.mjs`, 'utf8')
        const index = readFileSync(`${viteRoot}/index.html`, 'utf8')

        assert.equal(statSync(ownedRoot).mode & 0o777, 0o700)
        for (const directory of [
          'home',
          'migrations',
          'state',
          'tmp',
          'vite-root',
          'xdg-cache',
          'xdg-config',
          'xdg-data',
        ]) {
          assert.equal(statSync(`${ownedRoot}/${directory}`).mode & 0o777, 0o700)
        }
        for (const file of [
          configPath,
          `${viteRoot}/.bwm-harness-vite.mjs`,
          `${viteRoot}/index.html`,
        ]) {
          assert.equal(statSync(file).mode & 0o777, 0o600)
        }
        assert.doesNotMatch(wrangler, /"secrets"/)
        const migrationNames = readdirSync(`${ownedRoot}/migrations`).sort()
        assert.deepEqual(migrationNames, STAGE_A_MIGRATION_NAMES)
        assert.equal(JSON.parse(wrangler).d1_databases[0].migrations_dir, `${ownedRoot}/migrations`)
        assert.match(vite, /envDir: false/)
        assert.match(vite, /inspectorPort: false/)
        assert.match(vite, /remoteBindings: false/)
        assert.match(vite, new RegExp(`persistState: \\{ path: ${JSON.stringify(state)}`))
        assert.match(index, /\/@fs\/.*\/src\/main\.jsx/)
        for (const secret of [
          'parent-cloud-token-sentinel',
          'parent-secret-sentinel',
          key(1),
          key(2),
          key(3),
        ]) {
          assert.doesNotMatch(`${wrangler}\n${vite}\n${index}`, new RegExp(secret))
        }
        assert.equal(Object.hasOwn(input.env, 'PATH'), false)
        assert.equal(Object.hasOwn(input.env, 'CF_API_TOKEN'), false)
        assert.equal(input.env.HOME, `${ownedRoot}/home`)
        assert.equal(input.env.TMPDIR, `${ownedRoot}/tmp`)
        assert.equal(input.env.NODE_DISABLE_COMPILE_CACHE, '1')
        return { code: 1, stderr: 'sanitized', stdout: '' }
      },
      signals: new EventEmitter(),
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_MIGRATION_FAILED', ok: false })
  assert.equal(existsSync(ownedRoot), false)
})

test('runner stops when Vite exits before an in-flight readiness request', {
  timeout: 200,
}, async () => {
  const removed = []
  const vite = new EventEmitter()
  vite.pid = 42
  vite.kill = () => true
  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: {
      ...fakeHarnessDeps(),
      fetch: async () => new Promise(() => {}),
      makePersistenceDirectory: async () => '/tmp/bwm-early-exit-owned',
      maxReadinessAttempts: 1,
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      removePersistenceDirectory: async (path) => removed.push(path),
      runChild: async (input) => ({
        code: 0,
        stderr: '',
        stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
          ? 'SEED_LOCAL_COMPLETE\n'
          : '',
      }),
      signals: new EventEmitter(),
      startChild: () => {
        queueMicrotask(() => vite.emit('exit', 2, null))
        return vite
      },
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_CHILD_EXITED', ok: false })
  assert.deepEqual(removed, ['/tmp/bwm-early-exit-owned'])
})

test('runner rejects a listener ownership change across the readiness response', async () => {
  let probes = 0
  const vite = new EventEmitter()
  vite.pid = 42
  vite.kill = (signal) => {
    queueMicrotask(() => vite.emit('exit', 0, signal))
    return true
  }
  const result = await runAppE2E({
    argv: [],
    env: {},
    deps: {
      ...fakeHarnessDeps(),
      assertListenerOwner: async () => `listener-${probes++}`,
      makePersistenceDirectory: async () => '/tmp/bwm-listener-swap',
      maxReadinessAttempts: 1,
      randomKey: (() => {
        let byte = 1
        return () => key(byte++)
      })(),
      removePersistenceDirectory: async () => {},
      runChild: async (input) => ({
        code: 0,
        stderr: '',
        stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
          ? 'SEED_LOCAL_COMPLETE\n'
          : '',
      }),
      signals: new EventEmitter(),
      startChild: () => vite,
      fetch: async () => readyResponse(),
      now: () => NOW_MS,
      exitAfterReady: true,
    },
  })

  assert.deepEqual(result, { code: 'APP_E2E_READINESS_FAILED', ok: false })
  assert.equal(probes, 2)
})

test('runner removes its directory on migration, seed, pre-Vite, and readiness failures', async () => {
  for (const failureAt of ['migration', 'seed', 'start', 'readiness']) {
    const removed = []
    const vite = new EventEmitter()
    vite.kill = () => {
      queueMicrotask(() => vite.emit('exit', 1, null))
      return true
    }
    let runCount = 0
    const result = await runAppE2E({
      argv: [],
      env: { HOME: '/safe/home', PATH: '/safe/bin' },
      deps: {
        ...fakeHarnessDeps(),
        makePersistenceDirectory: async () => `/tmp/bwm-${failureAt}-owned`,
        removePersistenceDirectory: async (path) => removed.push(path),
        randomKey: (() => {
          let byte = 1
          return () => key(byte++)
        })(),
        runChild: async (input) => {
          runCount += 1
          if ((failureAt === 'migration' && runCount === 1)
            || (failureAt === 'seed' && runCount === 2)) {
            return { code: 1, stdout: 'sensitive', stderr: 'sensitive' }
          }
          return {
            code: 0,
            stdout: input.args.some((value) => value.endsWith('/seed-local.mjs'))
              ? 'SEED_LOCAL_COMPLETE\n'
              : '',
            stderr: '',
          }
        },
        startChild: () => {
          if (failureAt === 'start') throw new Error('sensitive')
          return vite
        },
        fetch: async () => failureAt === 'readiness'
          ? readyResponse({ status: 500 })
          : readyResponse(),
        sleep: async () => {
          if (failureAt === 'readiness') throw new Error('stop')
        },
        signals: new EventEmitter(),
        now: Date.now,
        maxReadinessAttempts: 1,
        exitAfterReady: true,
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.code, /^APP_E2E_(?:MIGRATION|SEED|START|READINESS)_FAILED$/)
    assert.deepEqual(removed, [`/tmp/bwm-${failureAt}-owned`])
    assert.doesNotMatch(JSON.stringify(result), /sensitive/)
  }
})
