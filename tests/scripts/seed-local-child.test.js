import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBoundedLocalChild } from '../../scripts/seed-local.mjs'

const processAbsent = (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

const fakeClock = () => {
  let nextId = 1
  const timers = new Map()
  return {
    active: () => timers.size,
    clearTimeout: (id) => {
      timers.delete(id)
    },
    runAll: async () => {
      let turns = 0
      while (timers.size > 0) {
        assert.ok(turns < 20, 'fake clock exceeded its bounded timer budget')
        const pending = [...timers.values()]
        timers.clear()
        for (const callback of pending) callback()
        await Promise.resolve()
        turns += 1
      }
      await Promise.resolve()
    },
    setTimeout: (callback) => {
      const id = nextId
      nextId += 1
      timers.set(id, callback)
      return id
    },
  }
}

for (const [label, trigger, expectedCode] of [
  ['deadline', async (clock) => clock.runAll(), 'SEED_LOCAL_CHILD_DEADLINE'],
  ['oversized output', async (_clock, child) => {
    child.stdout.emit('data', Buffer.alloc(65_537))
  }, 'SEED_LOCAL_CHILD_OUTPUT_INVALID'],
  ['child error', async (_clock, child) => {
    child.emit('error', new Error('raw child error'))
  }, 'SEED_LOCAL_CHILD_FAILED'],
]) {
  test(`detached seed child ${label} finalizes without a terminal event`, async () => {
    const child = new EventEmitter()
    child.pid = 999_999_999
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    const clock = fakeClock()
    const signals = []
    let groupAlive = true

    const running = runBoundedLocalChild({
      args: ['child.js'],
      cwd: '/tmp',
      env: {},
      executable: process.execPath,
      shell: false,
    }, {
      clearTimeoutImpl: clock.clearTimeout,
      deadlineMs: 1,
      groupExistsImpl: () => groupAlive,
      setTimeoutImpl: clock.setTimeout,
      signalGroupImpl: (_groupId, signal) => {
        signals.push(signal)
        if (signal === 'SIGKILL') groupAlive = false
      },
      sleep: async () => {},
      spawnImpl: () => child,
    })
    await trigger(clock, child)
    await clock.runAll()
    const outcome = await Promise.race([
      running.catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
    ])

    assert.notEqual(outcome, 'hung')
    assert.equal(outcome instanceof Error, true)
    assert.equal(outcome.message, expectedCode)
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(groupAlive, false)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.listenerCount('close'), 0)
    assert.equal(child.listenerCount('exit'), 0)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.equal(child.stderr.listenerCount('data'), 0)
    assert.equal(clock.active(), 0)
  })
}

for (const exitCode of [0, 7]) {
  test(`detached seed child rejects and removes an orphaned group after leader exit ${exitCode}`, {
    skip: process.platform !== 'darwin' && process.platform !== 'linux',
    timeout: 5_000,
  }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'bwm-seed-orphan-'))
    const processPath = join(root, 'processes.json')
    let processIds = null
    const readProcessIds = () => {
      try {
        const parsed = JSON.parse(readFileSync(processPath, 'utf8'))
        if (Number.isSafeInteger(parsed.group) && parsed.group > 0
          && Number.isSafeInteger(parsed.descendant) && parsed.descendant > 0) {
          processIds = parsed
        }
      } catch {
        // The leader has not published both process IDs yet.
      }
      return processIds
    }
    t.after(() => {
      const ids = readProcessIds()
      if (ids) {
        try { process.kill(-ids.group, 'SIGKILL') } catch { /* Already absent. */ }
      }
      rmSync(root, { force: true, recursive: true })
    })
    const descendantSource = `
      process.on('SIGTERM', () => {})
      process.send('ready')
      setInterval(() => {}, 1000)
    `
    const leaderSource = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      child.once('message', () => {
        writeFileSync(
          ${JSON.stringify(processPath)},
          JSON.stringify({ descendant: child.pid, group: process.pid }),
        )
        child.disconnect()
        child.unref()
        process.exit(${exitCode})
      })
    `

    await assert.rejects(
      runBoundedLocalChild({
        args: ['-e', leaderSource],
        cwd: process.cwd(),
        env: {},
        executable: process.execPath,
        shell: false,
      }, {
        deadlineMs: 3_000,
      }),
      /^Error: SEED_LOCAL_CHILD_ORPHANED$/,
    )

    const ids = readProcessIds()
    assert.ok(ids)
    assert.equal(processAbsent(-ids.group), true)
    assert.equal(processAbsent(ids.descendant), true)
  })
}

for (const [exitCode, expectedError] of [
  [0, null],
  [7, /^Error: SEED_LOCAL_CHILD_FAILED$/],
]) {
  test(`detached seed child preserves leader exit ${exitCode} when its group is absent`, {
    skip: process.platform !== 'darwin' && process.platform !== 'linux',
    timeout: 2_000,
  }, async () => {
    const running = runBoundedLocalChild({
      args: ['-e', `process.exit(${exitCode})`],
      cwd: process.cwd(),
      env: {},
      executable: process.execPath,
      shell: false,
    }, {
      deadlineMs: 1_000,
    })

    if (expectedError) {
      await assert.rejects(running, expectedError)
    } else {
      await assert.doesNotReject(running)
    }
  })
}

test('detached seed child bounds TERM and KILL polls when a group remains observable', async () => {
  const child = new EventEmitter()
  child.pid = 999_999_999
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  const signals = []
  let checks = 0

  const running = runBoundedLocalChild({
    args: ['child.js'],
    cwd: '/tmp',
    env: {},
    executable: process.execPath,
    shell: false,
  }, {
    groupExistsImpl: () => {
      checks += 1
      return true
    },
    signalGroupImpl: (_groupId, signal) => {
      signals.push(signal)
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })
  child.emit('close', 0, null)

  await assert.rejects(running, /^Error: SEED_LOCAL_CHILD_ORPHANED$/)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.ok(checks > 2)
  assert.ok(checks < 100)
})

test('invalid detached seed child rejects when bounded group cleanup fails', async () => {
  const child = new EventEmitter()
  child.pid = 999_999_999
  child.kill = () => true

  await assert.rejects(
    runBoundedLocalChild({
      args: ['child.js'],
      cwd: '/tmp',
      env: {},
      executable: process.execPath,
      shell: false,
    }, {
      groupExistsImpl: () => true,
      signalGroupImpl: () => {},
      sleep: async () => {
        throw new Error('raw cleanup failure')
      },
      spawnImpl: () => child,
    }),
    /^Error: SEED_LOCAL_CHILD_FAILED$/,
  )
})

test('bounded child drains but never retains output arriving after termination starts', async () => {
  const child = new EventEmitter()
  child.pid = 999_999_999
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  let retainedBuffers = 0
  const running = runBoundedLocalChild({
    args: ['child.js'],
    cwd: '/tmp',
    env: {},
    executable: process.execPath,
    shell: false,
  }, {
    deadlineMs: 1,
    onRetainedChunk: () => {
      retainedBuffers += 1
    },
    spawnImpl: () => child,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  for (let index = 0; index < 64; index += 1) {
    child.stdout.emit('data', Buffer.alloc(1024))
  }
  child.emit('close', null, 'SIGTERM')
  await assert.rejects(running, /^Error: SEED_LOCAL_CHILD_DEADLINE$/)
  assert.equal(retainedBuffers, 0)
})

test('bounded seed child installs an error listener before rejecting an invalid spawn result', async () => {
  const child = new EventEmitter()
  child.pid = undefined
  child.kill = () => true

  const running = runBoundedLocalChild({
    args: ['child.js'],
    cwd: '/tmp',
    env: {},
    executable: process.execPath,
    shell: false,
  }, {
    spawnImpl: () => child,
  })
  const rejected = assert.rejects(running, /^Error: SEED_LOCAL_CHILD_FAILED$/)

  assert.equal(child.listenerCount('error') > 0, true)
  await rejected
})

test('inherited-group seed child removes retained listeners after fast settlement', async () => {
  const child = new EventEmitter()
  child.pid = 999_999_999
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true

  const running = runBoundedLocalChild({
    args: ['child.js'],
    cwd: '/tmp',
    env: {},
    executable: process.execPath,
    shell: false,
  }, {
    detached: false,
    spawnImpl: () => child,
  })
  child.emit('exit', 0, null)

  await running
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
})

test('inherited-group seed child settles on leader exit when a descendant holds stdio', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
  timeout: 2_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bwm-seed-child-'))
  const pidPath = join(root, 'descendant.pid')
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const source = `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"
    ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child.once('message', () => {
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))
      process.stdout.write('READY\\\\n')
    })
    setInterval(() => {}, 1000)
  `
  let descendantPid
  const startedAt = Date.now()
  const readDescendant = () => {
    try {
      const value = Number(readFileSync(pidPath, 'utf8'))
      if (Number.isSafeInteger(value) && value > 0) descendantPid = value
    } catch {
      // The descendant has not reported readiness yet.
    }
  }
  const cleanup = setTimeout(() => {
    readDescendant()
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGKILL') } catch { /* Already absent. */ }
    }
  }, 800)
  try {
    await assert.rejects(
      runBoundedLocalChild({
        args: ['-e', source],
        cwd: process.cwd(),
        env: {},
        executable: process.execPath,
        shell: false,
      }, {
        deadlineMs: 200,
        detached: false,
      }),
      /^Error: SEED_LOCAL_CHILD_DEADLINE$/,
    )
    assert.ok(Date.now() - startedAt < 500)
  } finally {
    clearTimeout(cleanup)
    readDescendant()
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGKILL') } catch { /* Already absent. */ }
    }
  }
})
