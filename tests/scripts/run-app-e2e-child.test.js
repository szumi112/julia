import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseDarwinListenerSnapshot,
  parseLinuxListenerTables,
  runBoundedAppChild,
  stopAppE2EChild,
  validateLinuxListenerOwnership,
  waitForAppE2ECondition,
} from '../../scripts/run-app-e2e.mjs'

const invocation = () => ({
  args: ['--version'],
  command: process.execPath,
  cwd: process.cwd(),
  env: {},
  shell: false,
})

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

const immediateClock = () => {
  let nextId = 1
  const timers = new Set()
  return {
    active: () => timers.size,
    clearTimeout: (id) => {
      timers.delete(id)
    },
    setTimeout: (callback) => {
      const id = nextId
      nextId += 1
      timers.add(id)
      callback()
      return id
    },
  }
}

const fakeChild = () => {
  const child = new EventEmitter()
  child.pid = 999_999_999
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  return child
}

const lateOwnedGroupRace = () => {
  const rootGroup = 999_999_999
  const lateGroup = 999_999_998
  const signals = []
  let lateAlive = false
  let rootAlive = true
  let rootAbsenceObserved = false
  let snapshots = 0
  return {
    groupExists(groupId) {
      if (groupId === rootGroup) {
        if (!rootAlive && !rootAbsenceObserved) {
          rootAbsenceObserved = true
          lateAlive = true
        }
        return rootAlive
      }
      assert.equal(groupId, lateGroup)
      return lateAlive
    },
    ownedGroups() {
      snapshots += 1
      return snapshots >= 3
        ? [rootGroup, lateGroup]
        : [rootGroup]
    },
    signal(groupId, signal) {
      signals.push([groupId, signal])
      if (groupId === rootGroup) rootAlive = false
      if (groupId === lateGroup && signal === 'SIGKILL') lateAlive = false
    },
    state() {
      return {
        lateAlive,
        lateGroup,
        signals,
        snapshots,
      }
    },
  }
}

for (const [label, trigger, expectedCode] of [
  ['deadline', async (clock) => clock.runAll(), 'APP_E2E_CHILD_DEADLINE'],
  ['oversized output', async (_clock, child) => {
    child.stdout.emit('data', Buffer.alloc(65_537))
  }, 'APP_E2E_CHILD_OUTPUT_INVALID'],
  ['spawn error', async (_clock, child) => {
    child.emit('error', new Error('raw child error'))
  }, 'APP_E2E_CHILD_FAILED'],
]) {
  test(`bounded app child ${label} finalizes without close or exit`, async () => {
    const child = fakeChild()
    const clock = fakeClock()
    const checks = []
    const events = []
    const signals = []
    let groupAlive = true
    let settledCalls = 0
    const running = runBoundedAppChild(invocation(), {
      clearTimeoutImpl: clock.clearTimeout,
      deadlineMs: 1,
      groupExistsImpl: () => {
        checks.push(groupAlive)
        events.push(`check:${groupAlive}`)
        return groupAlive
      },
      onSettled: () => {
        settledCalls += 1
      },
      setTimeoutImpl: clock.setTimeout,
      signalGroupImpl: (_groupId, signal) => {
        signals.push(signal)
        events.push(`signal:${signal}`)
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
    assert.deepEqual(events, [
      'signal:SIGTERM',
      'check:true',
      'signal:SIGKILL',
      'check:false',
      'check:false',
      'check:false',
    ])
    assert.equal(checks.includes(true), true)
    assert.equal(checks.at(-1), false)
    assert.equal(groupAlive, false)
    assert.equal(settledCalls, 1)
    child.emit('close', 0, null)
    await clock.runAll()
    assert.equal(settledCalls, 1)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.listenerCount('close'), 0)
    assert.equal(child.listenerCount('exit'), 0)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.equal(child.stderr.listenerCount('data'), 0)
    assert.equal(clock.active(), 0)
  })
}

test('bounded app child settles after TERM and KILL signaling failures when absence is proven', async () => {
  const child = fakeChild()
  const clock = fakeClock()
  const signals = []
  let checks = 0
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    deadlineMs: 1,
    groupExistsImpl: () => {
      checks += 1
      return checks === 1
    },
    onSettled: () => {
      settledCalls += 1
    },
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: (_groupId, signal) => {
      signals.push(signal)
      throw new Error('raw signal failure')
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })

  await clock.runAll()
  const outcome = await Promise.race([
    running.catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
  ])
  assert.notEqual(outcome, 'hung')
  assert.match(outcome.message, /^APP_E2E_CHILD_DEADLINE$/)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.ok(checks >= 2)
  assert.equal(settledCalls, 1)
  child.emit('close', 0, null)
  await clock.runAll()
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

test('bounded app child reports an owned group still observable after KILL', async () => {
  const child = fakeChild()
  const clock = fakeClock()
  const signals = []
  let checks = 0
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    deadlineMs: 1,
    groupExistsImpl: () => {
      checks += 1
      return true
    },
    onSettled: () => {
      settledCalls += 1
    },
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: (_groupId, signal) => {
      signals.push(signal)
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })

  await clock.runAll()
  const outcome = await Promise.race([
    running.catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
  ])
  assert.notEqual(outcome, 'hung')
  assert.match(outcome.message, /^APP_E2E_CHILD_ORPHANED$/)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.ok(checks > 2)
  assert.ok(checks < 100)
  assert.equal(settledCalls, 1)
  child.emit('close', 0, null)
  await clock.runAll()
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

test('bounded terminal cleanup rescans ownership after the first group disappears', async () => {
  const child = fakeChild()
  const clock = fakeClock()
  const race = lateOwnedGroupRace()
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    groupExistsImpl: race.groupExists,
    onSettled: () => {
      settledCalls += 1
    },
    ownedGroupsImpl: race.ownedGroups,
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: race.signal,
    sleep: async () => {},
    spawnImpl: () => child,
  })

  child.emit('close', 0, null)
  const outcome = await Promise.race([
    running.catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
  ])

  assert.notEqual(outcome, 'hung')
  assert.match(outcome.message, /^APP_E2E_CHILD_ORPHANED$/)
  const state = race.state()
  assert.ok(state.snapshots >= 3)
  assert.equal(state.lateAlive, false)
  assert.ok(state.signals.some(([groupId, signal]) => (
    groupId === state.lateGroup && signal === 'SIGKILL'
  )))
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

test('bounded forced cleanup rescans ownership after the first group disappears', async () => {
  const child = fakeChild()
  const clock = fakeClock()
  const race = lateOwnedGroupRace()
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    deadlineMs: 1,
    groupExistsImpl: race.groupExists,
    onSettled: () => {
      settledCalls += 1
    },
    ownedGroupsImpl: race.ownedGroups,
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: race.signal,
    sleep: async () => {},
    spawnImpl: () => child,
  })

  await clock.runAll()
  const outcome = await Promise.race([
    running.catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
  ])

  assert.notEqual(outcome, 'hung')
  assert.match(outcome.message, /^APP_E2E_CHILD_DEADLINE$/)
  const state = race.state()
  assert.ok(state.snapshots >= 3)
  assert.equal(state.lateAlive, false)
  assert.ok(state.signals.some(([groupId, signal]) => (
    groupId === state.lateGroup && signal === 'SIGKILL'
  )))
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

for (const exitCode of [0, 7]) {
  test(`bounded app child preserves natural exit ${exitCode} after proving group absence`, async () => {
    const child = fakeChild()
    const clock = fakeClock()
    let settledCalls = 0
    const running = runBoundedAppChild(invocation(), {
      clearTimeoutImpl: clock.clearTimeout,
      groupExistsImpl: () => false,
      onSettled: () => {
        settledCalls += 1
      },
      setTimeoutImpl: clock.setTimeout,
      signalGroupImpl: () => {
        throw new Error('must not signal an absent group')
      },
      sleep: async () => {},
      spawnImpl: () => child,
    })

    child.emit('close', exitCode, null)
    assert.deepEqual(await running, {
      code: exitCode,
      stderr: '',
      stdout: '',
    })
    assert.equal(settledCalls, 1)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.listenerCount('close'), 0)
    assert.equal(child.listenerCount('exit'), 0)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.equal(child.stderr.listenerCount('data'), 0)
    assert.equal(clock.active(), 0)
  })
}

test('bounded app child deadline settles while an escaped descendant retains stderr', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
  timeout: 5_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bwm-app-child-retained-pipe-'))
  const pidPath = join(root, 'descendant.pid')
  let descendantPid = null
  const readDescendantPid = () => {
    try {
      const value = Number(readFileSync(pidPath, 'utf8'))
      if (Number.isSafeInteger(value) && value > 0) descendantPid = value
    } catch {
      // The descendant has not published its PID yet.
    }
    return descendantPid
  }
  const removeDescendant = async () => {
    const pid = readDescendantPid()
    if (!pid) return
    try { process.kill(-pid, 'SIGKILL') } catch { /* Already absent. */ }
    await waitForAppE2ECondition(() => processAbsent(pid), {
      attempts: 40,
      delayMs: 10,
    })
  }
  t.after(async () => {
    await removeDescendant()
    rmSync(root, { force: true, recursive: true })
  })
  const descendantSource = `
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
  `
  const leaderSource = `
    const { spawn } = require('node:child_process')
    const { writeFileSync } = require('node:fs')
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))
    child.unref()
    process.exit(0)
  `
  const startedAt = Date.now()

  const running = runBoundedAppChild({
      args: ['-e', leaderSource],
      command: process.execPath,
      cwd: process.cwd(),
      env: {},
      shell: false,
    }, {
      deadlineMs: 100,
    })
  const outcome = await Promise.race([
    running.catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 1_500)),
  ])
  if (outcome === 'hung') await removeDescendant()
  assert.notEqual(outcome, 'hung')
  assert.match(outcome.message, /^APP_E2E_CHILD_DEADLINE$/)
  assert.ok(Date.now() - startedAt < 1_500)
  assert.ok(readDescendantPid())
  assert.equal(processAbsent(descendantPid), true)
})

test('condition wait reports a predicate that remains false after its deadline', async () => {
  let checks = 0
  const result = await waitForAppE2ECondition(() => {
    checks += 1
    return false
  }, {
    attempts: 2,
    delayMs: 0,
    sleep: async () => {},
  })

  assert.equal(result, false)
  assert.equal(checks, 3)
})

test('bounded child removes listeners when an invalid spawn result has no PID', async () => {
  const child = new EventEmitter()
  child.pid = undefined
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  const clock = fakeClock()
  let settledCalls = 0

  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    onSettled: () => {
      settledCalls += 1
    },
    setTimeoutImpl: clock.setTimeout,
    spawnImpl: () => child,
  })

  await clock.runAll()
  await assert.rejects(running, /^Error: APP_E2E_CHILD_FAILED$/)
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(clock.active(), 0)
})

test('bounded child settles when spawn returns no child object', async () => {
  const clock = fakeClock()
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    onSettled: () => {
      settledCalls += 1
    },
    setTimeoutImpl: clock.setTimeout,
    spawnImpl: () => null,
  })

  await assert.rejects(
    clock.runAll().then(() => running),
    /^Error: APP_E2E_CHILD_FAILED$/,
  )
  assert.equal(settledCalls, 1)
  assert.equal(clock.active(), 0)
})

test('bounded child removes a malformed positive-PID spawn group before rejecting', async () => {
  const child = new EventEmitter()
  child.pid = 999_999_999
  child.stdout = new EventEmitter()
  child.stderr = null
  child.kill = () => true
  const clock = fakeClock()
  const signals = []
  let groupAlive = true
  let settledCalls = 0

  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    groupExistsImpl: () => groupAlive,
    onSettled: () => {
      settledCalls += 1
    },
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: (_groupId, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') groupAlive = false
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })

  await clock.runAll()
  await assert.rejects(running, /^Error: APP_E2E_CHILD_FAILED$/)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(groupAlive, false)
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

for (const [label, invalidOnce] of [
  ['non-callable once', true],
  ['throwing once', () => {
    throw new Error('raw once failure with secret-value')
  }],
]) {
  test(`bounded child cleans a positive-PID spawn result with ${label}`, async () => {
    const child = new EventEmitter()
    child.pid = 999_999_999
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    child.once = invalidOnce
    const clock = fakeClock()
    const signals = []
    let groupAlive = true
    let settledCalls = 0

    const running = runBoundedAppChild(invocation(), {
      clearTimeoutImpl: clock.clearTimeout,
      groupExistsImpl: () => groupAlive,
      onSettled: () => {
        settledCalls += 1
      },
      setTimeoutImpl: clock.setTimeout,
      signalGroupImpl: (_groupId, signal) => {
        signals.push(signal)
        if (signal === 'SIGKILL') groupAlive = false
      },
      sleep: async () => {},
      spawnImpl: () => child,
    })

    await clock.runAll()
    const outcome = await running.catch((error) => error)
    assert.equal(outcome instanceof Error, true)
    assert.equal(outcome.message, 'APP_E2E_CHILD_FAILED')
    assert.equal(outcome.message.includes('secret-value'), false)
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(groupAlive, false)
    assert.equal(settledCalls, 1)
    await clock.runAll()
    assert.equal(settledCalls, 1)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.equal(child.stderr.listenerCount('data'), 0)
    assert.equal(clock.active(), 0)
  })
}

test('bounded child cleans a positive-PID spawn result when close-listener registration throws', async () => {
  const child = fakeChild()
  const registerOnce = child.once.bind(child)
  child.once = (event, listener) => {
    if (event === 'close') {
      throw new Error('raw close-listener failure with secret-value')
    }
    return registerOnce(event, listener)
  }
  const clock = fakeClock()
  const signals = []
  let groupAlive = true
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    deadlineMs: 1,
    groupExistsImpl: () => groupAlive,
    onSettled: () => {
      settledCalls += 1
    },
    ownedGroupsImpl: () => [child.pid],
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: (_groupId, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') groupAlive = false
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })

  await clock.runAll()
  const outcome = await running.catch((error) => error)
  assert.equal(outcome instanceof Error, true)
  assert.equal(outcome.message, 'APP_E2E_CHILD_FAILED')
  assert.equal(outcome.message.includes('secret-value'), false)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(groupAlive, false)
  assert.equal(settledCalls, 1)
  await clock.runAll()
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

test('bounded child cleans up when a retained-chunk callback throws', async () => {
  const child = fakeChild()
  const clock = fakeClock()
  const signals = []
  let groupAlive = true
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    deadlineMs: 1,
    groupExistsImpl: () => groupAlive,
    onRetainedChunk: () => {
      throw new Error('raw retained-chunk failure with secret-value')
    },
    onSettled: () => {
      settledCalls += 1
    },
    ownedGroupsImpl: () => [child.pid],
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: (_groupId, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') groupAlive = false
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })

  let deliveryError = null
  try {
    child.stdout.emit('data', Buffer.from('retained'))
  } catch (error) {
    deliveryError = error
  }
  assert.equal(deliveryError, null)
  await clock.runAll()
  const outcome = await running.catch((error) => error)
  assert.equal(outcome instanceof Error, true)
  assert.equal(outcome.message, 'APP_E2E_CHILD_FAILED')
  assert.equal(outcome.message.includes('secret-value'), false)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(groupAlive, false)
  assert.equal(settledCalls, 1)
  child.emit('close', 0, null)
  await clock.runAll()
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

test('bounded child does not schedule work after close-listener registration settles it', async () => {
  const child = fakeChild()
  const registerOnce = child.once.bind(child)
  child.once = (event, listener) => {
    if (event === 'close') {
      listener(0, null)
      return child
    }
    return registerOnce(event, listener)
  }
  const clock = fakeClock()
  let onSpawnCalls = 0
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    groupExistsImpl: () => false,
    onSettled: () => {
      settledCalls += 1
    },
    onSpawn: () => {
      onSpawnCalls += 1
    },
    ownedGroupsImpl: () => [child.pid],
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: () => {
      throw new Error('must not signal an absent group')
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })

  assert.deepEqual(await running, {
    code: 0,
    stderr: '',
    stdout: '',
  })
  assert.equal(onSpawnCalls, 0)
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

test('bounded child handles an error emitted during error-listener registration', async () => {
  const child = fakeChild()
  const registerOnce = child.once.bind(child)
  child.once = (event, listener) => {
    const registered = registerOnce(event, listener)
    if (event === 'error') {
      child.emit('error', new Error('raw synchronous spawn failure with secret-value'))
    }
    return registered
  }
  const clock = fakeClock()
  const signals = []
  let groupAlive = true
  let onSpawnCalls = 0
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    groupExistsImpl: () => groupAlive,
    onSettled: () => {
      settledCalls += 1
    },
    onSpawn: () => {
      onSpawnCalls += 1
    },
    ownedGroupsImpl: () => [child.pid],
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: (_groupId, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') groupAlive = false
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })

  assert.equal(onSpawnCalls, 0)
  await clock.runAll()
  const outcome = await running.catch((error) => error)
  assert.equal(outcome instanceof Error, true)
  assert.equal(outcome.message, 'APP_E2E_CHILD_FAILED')
  assert.equal(outcome.message.includes('secret-value'), false)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(groupAlive, false)
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

test('bounded child handles close emitted during stream-listener registration', async () => {
  const child = fakeChild()
  const registerData = child.stdout.on.bind(child.stdout)
  child.stdout.on = (event, listener) => {
    const registered = registerData(event, listener)
    if (event === 'data') child.emit('close', 0, null)
    return registered
  }
  const clock = fakeClock()
  let onSpawnCalls = 0
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    groupExistsImpl: () => false,
    onSettled: () => {
      settledCalls += 1
    },
    onSpawn: () => {
      onSpawnCalls += 1
    },
    ownedGroupsImpl: () => [child.pid],
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: () => {
      throw new Error('must not signal an absent group')
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })

  await clock.runAll()
  assert.deepEqual(await running, {
    code: 0,
    stderr: '',
    stdout: '',
  })
  assert.equal(onSpawnCalls, 0)
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

for (const boundary of ['ownership snapshot', 'signal']) {
  test(`bounded child schedules no cleanup timer after close during ${boundary}`, async () => {
    const child = fakeChild()
    const clock = fakeClock()
    const signals = []
    let snapshotCalls = 0
    let settledCalls = 0
    const running = runBoundedAppChild(invocation(), {
      clearTimeoutImpl: clock.clearTimeout,
      groupExistsImpl: () => false,
      onSettled: () => {
        settledCalls += 1
      },
      ownedGroupsImpl: () => {
        snapshotCalls += 1
        if (boundary === 'ownership snapshot' && snapshotCalls === 1) {
          child.emit('close', 0, null)
        }
        return [child.pid]
      },
      setTimeoutImpl: clock.setTimeout,
      signalGroupImpl: (_groupId, signal) => {
        signals.push(signal)
        if (boundary === 'signal' && signal === 'SIGTERM') {
          child.emit('close', 0, null)
        }
      },
      sleep: async () => {},
      spawnImpl: () => child,
    })

    child.stdout.emit('data', 'invalid')
    const outcome = await running.catch((error) => error)
    assert.equal(outcome instanceof Error, true)
    assert.equal(outcome.message, 'APP_E2E_CHILD_OUTPUT_INVALID')
    assert.deepEqual(signals, boundary === 'signal' ? ['SIGTERM'] : [])
    assert.equal(settledCalls, 1)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.listenerCount('close'), 0)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.equal(child.stderr.listenerCount('data'), 0)
    assert.equal(clock.active(), 0)
  })
}

test('bounded child clears synchronously fired timer handles before settlement returns', async () => {
  const child = fakeChild()
  const clock = immediateClock()
  const signals = []
  let groupAlive = true
  let onSpawnCalls = 0
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    deadlineMs: 1,
    groupExistsImpl: () => groupAlive,
    onSettled: () => {
      settledCalls += 1
    },
    onSpawn: () => {
      onSpawnCalls += 1
    },
    ownedGroupsImpl: () => [child.pid],
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: (_groupId, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') groupAlive = false
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })

  const outcome = await running.catch((error) => error)
  assert.equal(outcome instanceof Error, true)
  assert.equal(outcome.message, 'APP_E2E_CHILD_DEADLINE')
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(groupAlive, false)
  assert.equal(onSpawnCalls, 0)
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

test('bounded terminal cleanup kills the known group when sleep throws', async () => {
  const child = fakeChild()
  const clock = fakeClock()
  const signals = []
  let groupAlive = true
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    groupExistsImpl: () => groupAlive,
    onSettled: () => {
      settledCalls += 1
    },
    ownedGroupsImpl: () => [child.pid],
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: (_groupId, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') groupAlive = false
    },
    sleep: async () => {
      throw new Error('raw sleep failure with secret-value')
    },
    spawnImpl: () => child,
  })

  child.emit('close', 0, null)
  const outcome = await running.catch((error) => error)
  assert.equal(outcome instanceof Error, true)
  assert.equal(outcome.message, 'APP_E2E_CHILD_ORPHANED')
  assert.equal(outcome.message.includes('secret-value'), false)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(groupAlive, false)
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

test('bounded malformed-child cleanup rescans ownership after the first group disappears', async () => {
  const child = new EventEmitter()
  child.pid = 999_999_999
  child.stdout = new EventEmitter()
  child.stderr = null
  child.kill = () => true
  const clock = fakeClock()
  const race = lateOwnedGroupRace()
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    groupExistsImpl: race.groupExists,
    onSettled: () => {
      settledCalls += 1
    },
    ownedGroupsImpl: race.ownedGroups,
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: race.signal,
    sleep: async () => {},
    spawnImpl: () => child,
  })

  await clock.runAll()
  const outcome = await Promise.race([
    running.catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
  ])

  assert.notEqual(outcome, 'hung')
  assert.match(outcome.message, /^APP_E2E_CHILD_FAILED$/)
  const state = race.state()
  assert.ok(state.snapshots >= 3)
  assert.equal(state.lateAlive, false)
  assert.ok(state.signals.some(([groupId, signal]) => (
    groupId === state.lateGroup && signal === 'SIGKILL'
  )))
  assert.equal(settledCalls, 1)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

for (const [label, malformed, trigger] of [
  ['terminal', false, async (_clock, child) => {
    child.emit('close', 0, null)
  }],
  ['forced', false, async (clock) => {
    await clock.runAll()
  }],
  ['malformed', true, async (clock) => {
    await clock.runAll()
  }],
]) {
  test(`bounded ${label} cleanup kills the known group when ownership rescans throw`, async () => {
    const child = fakeChild()
    if (malformed) child.stderr = null
    const clock = fakeClock()
    const signals = []
    let groupAlive = true
    let settledCalls = 0
    const running = runBoundedAppChild(invocation(), {
      clearTimeoutImpl: clock.clearTimeout,
      deadlineMs: 1,
      groupExistsImpl: () => groupAlive,
      onSettled: () => {
        settledCalls += 1
      },
      ownedGroupsImpl: () => {
        throw new Error('raw ownership failure with secret-value')
      },
      setTimeoutImpl: clock.setTimeout,
      signalGroupImpl: (_groupId, signal) => {
        signals.push(signal)
        if (signal === 'SIGKILL') groupAlive = false
      },
      sleep: async () => {},
      spawnImpl: () => child,
    })

    await trigger(clock, child)
    const outcome = await running.catch((error) => error)
    assert.equal(outcome instanceof Error, true)
    assert.equal(outcome.message, 'APP_E2E_CHILD_ORPHANED')
    assert.equal(outcome.message.includes('secret-value'), false)
    assert.deepEqual(signals, malformed || label === 'forced'
      ? ['SIGTERM', 'SIGKILL']
      : ['SIGKILL'])
    assert.equal(groupAlive, false)
    assert.equal(settledCalls, 1)
    await clock.runAll()
    assert.equal(settledCalls, 1)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.listenerCount('close'), 0)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.equal(clock.active(), 0)
  })
}

test('bounded child cleans a positive-PID spawn result without a terminal interface', async () => {
  const child = {
    kill: () => true,
    pid: 999_999_999,
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
  }
  const clock = fakeClock()
  const signals = []
  let groupAlive = true
  let settledCalls = 0
  const running = runBoundedAppChild(invocation(), {
    clearTimeoutImpl: clock.clearTimeout,
    groupExistsImpl: () => groupAlive,
    onSettled: () => {
      settledCalls += 1
    },
    setTimeoutImpl: clock.setTimeout,
    signalGroupImpl: (_groupId, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') groupAlive = false
    },
    sleep: async () => {},
    spawnImpl: () => child,
  })

  await clock.runAll()
  await assert.rejects(running, /^Error: APP_E2E_CHILD_FAILED$/)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(groupAlive, false)
  assert.equal(settledCalls, 1)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(clock.active(), 0)
})

test('Darwin listener parser accepts one exact loopback socket only', () => {
  assert.deepEqual(
    parseDarwinListenerSnapshot('p123\nf9\nn127.0.0.1:5174\n'),
    { descriptor: 9, pid: 123 },
  )
  for (const output of [
    'p123\nf9\nn127.0.0.1:5174',
    'p123\nf9\nn*:5174\n',
    'p123\nf9\nn[::1]:5174\n',
    'p123\nf9\nn127.0.0.1:5174\nf10\nn127.0.0.1:5174\n',
    'p123\nf9\nn127.0.0.1:5174\np456\nf8\nn127.0.0.1:5174\n',
    'p123\ncnode\nf9\nn127.0.0.1:5174\n',
  ]) {
    assert.equal(parseDarwinListenerSnapshot(output), null)
  }
})

test('orderly stop kills an inherited descendant after the group leader closes', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
  timeout: 5_000,
}, async () => {
  const leaderSource = `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    child.once('message', () => process.send('ready'))
    process.on('SIGTERM', () => process.exit(0))
    setInterval(() => {}, 1000)
  `
  const leader = spawn(process.execPath, ['-e', leaderSource], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  try {
    await new Promise((resolve, reject) => {
      leader.once('error', reject)
      leader.once('message', resolve)
    })
    await stopAppE2EChild(leader, 'SIGTERM')
    assert.throws(
      () => process.kill(-leader.pid, 0),
      (error) => error?.code === 'ESRCH',
    )
  } finally {
    try { process.kill(-leader.pid, 'SIGKILL') } catch { /* Already absent. */ }
  }
})

test('Linux listener parser rejects wildcard, IPv6, and duplicate sockets', () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
  const row = (address, inode = '12345') => (
    `   0: ${address}:1436 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 ${inode}`
  )
  assert.deepEqual(
    parseLinuxListenerTables(`${header}\n${row('0100007F')}\n`, `${header}\n`),
    { inode: '12345' },
  )
  for (const [tcp, tcp6] of [
    [`${header}\n${row('00000000')}\n`, `${header}\n`],
    [`${header}\n`, `${header}\n${row('00000000000000000000000001000000')}\n`],
    [`${header}\n${row('0100007F')}\n${row('0100007F', '12346')}\n`, `${header}\n`],
  ]) {
    assert.equal(parseLinuxListenerTables(tcp, tcp6), null)
  }
})

test('Linux ownership validator requires one stable FD in the Vite process group and net namespace', () => {
  const valid = {
    after: { groupId: 42, pid: 43, startTime: '100' },
    before: { groupId: 42, pid: 43, startTime: '100' },
    listener: { inode: '12345' },
    ownerNamespace: 'net:[7]',
    owners: [{ descriptor: 9, pid: 43 }],
    tablesStable: true,
    viteNamespace: 'net:[7]',
    vitePid: 42,
  }
  assert.match(validateLinuxListenerOwnership(valid), /^[a-f0-9]{64}$/)
  for (const patch of [
    { owners: [...valid.owners, { descriptor: 10, pid: 43 }] },
    { owners: [{ descriptor: 9, pid: 44 }] },
    { before: { groupId: 41, pid: 43, startTime: '100' } },
    { after: { groupId: 42, pid: 43, startTime: '101' } },
    { viteNamespace: 'net:[8]' },
    { tablesStable: false },
  ]) {
    assert.equal(validateLinuxListenerOwnership({ ...valid, ...patch }), null)
  }
})
