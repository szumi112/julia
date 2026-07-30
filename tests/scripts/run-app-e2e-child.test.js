import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
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

test('bounded child attaches an error listener before rejecting an invalid spawn result', async () => {
  const child = new EventEmitter()
  child.pid = undefined
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true

  const running = runBoundedAppChild(invocation(), {
    spawnImpl: () => child,
  })
  const rejected = assert.rejects(running, /^Error: APP_E2E_CHILD_FAILED$/)

  assert.equal(child.listenerCount('error') > 0, true)
  await rejected
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
