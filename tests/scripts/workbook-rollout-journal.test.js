import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmod, lstat, mkdtemp, open, readFile, realpath, rename, rm, symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  createWorkbookRolloutJournal,
  validateWorkbookRolloutJournalPrivateFileFlags,
} from '../../scripts/workbook-rollout-journal.mjs'

const initial = Object.freeze({
  schema: 'workbook_rollout_journal.v3',
  environment: 'staging',
  fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
  creatorId: 'stf_rollout_owner',
  phase: 'initialized',
  importIdentity: null,
  resolutionArtifact: null,
  resolutionHistory: [],
  rebind: null,
  projection: null,
  result: null,
})

async function interceptNextHandleRead(action) {
  const sample = await open(import.meta.filename, 'r')
  const prototype = Object.getPrototypeOf(sample)
  const original = prototype.readFile
  await sample.close()
  let intercepted = false
  prototype.readFile = async function (...args) {
    const bytes = await original.apply(this, args)
    if (!intercepted) {
      intercepted = true
      await action(bytes)
    }
    return bytes
  }
  return () => { prototype.readFile = original }
}

test('journal atomically creates and replaces only a strict 0600 regular file', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-test-')))
  const path = join(root, 'resume.json')
  try {
    await chmod(root, 0o700)
    const journal = await createWorkbookRolloutJournal(path)
    assert.equal(await journal.load(), null)
    await journal.save(initial)
    assert.equal((await lstat(path)).mode & 0o777, 0o600)
    assert.deepEqual(await journal.load(), initial)
    await journal.save({
      ...initial,
      phase: 'import_confirmed',
      importIdentity: { importId: 'wbi_atomic', artifactId: 'wba_atomic' },
    })
    assert.equal(JSON.parse(await readFile(path, 'utf8')).phase, 'import_confirmed')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('journal refuses permissive files, symlinks and non-private parents', async () => {
  for (const setup of ['permissive-file', 'symlink', 'permissive-parent']) {
    const root = await mkdtemp(join(tmpdir(), 'bwm-journal-hostile-'))
    const path = join(root, 'resume.json')
    try {
      await chmod(root, setup === 'permissive-parent' ? 0o755 : 0o700)
      if (setup === 'permissive-file') await writeFile(path, '{}', { mode: 0o644 })
      if (setup === 'symlink') {
        const target = join(root, 'target.json')
        await writeFile(target, '{}', { mode: 0o600 })
        await symlink(target, path)
      }
      await assert.rejects(createWorkbookRolloutJournal(path),
        /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test('journal exclusive run lock refuses concurrent and pre-existing lock owners', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-lock-')))
  const path = join(root, 'resume.json')
  const lockPath = `${path}.lock`
  try {
    await chmod(root, 0o700)
    const first = await createWorkbookRolloutJournal(path)
    const second = await createWorkbookRolloutJournal(path)
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let entered = false
    const running = first.runExclusive(async () => {
      entered = true
      assert.equal((await lstat(lockPath)).mode & 0o777, 0o600)
      await gate
      return 'complete'
    })
    while (!entered) await new Promise((resolve) => setImmediate(resolve))
    let secondEntered = false
    await assert.rejects(second.runExclusive(async () => {
      secondEntered = true
    }), /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
    assert.equal(secondEntered, false)
    release()
    assert.equal(await running, 'complete')
    assert.equal(await second.runExclusive(async () => 'after-release'), 'after-release')

    await writeFile(lockPath, 'workbook_rollout_lock.v1\n', { mode: 0o600, flag: 'wx' })
      .catch((error) => { if (error?.code !== 'EEXIST') throw error })
    assert.equal(await first.runExclusive(async () => 'persistent-marker-reused'),
      'persistent-marker-reused')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('journal kernel lock is released when the rollout process is killed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-lock-crash-')))
  const path = join(root, 'resume.json')
  let child
  try {
    await chmod(root, 0o700)
    const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/workbook-rollout-journal.mjs')).href
    const source = `
      import { createWorkbookRolloutJournal } from ${JSON.stringify(moduleUrl)}
      const journal = await createWorkbookRolloutJournal(${JSON.stringify(path)})
      await journal.runExclusive(async () => {
        process.stdout.write('entered\\n')
        await new Promise(() => {})
      })
    `
    child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    for await (const chunk of child.stdout) {
      output += chunk.toString('utf8')
      if (output === 'entered\n') break
      if (output.length > 16) throw new Error('unexpected child output')
    }
    assert.equal(output, 'entered\n')
    child.kill('SIGKILL')
    await once(child, 'exit')
    child = null
    const journal = await createWorkbookRolloutJournal(path)
    let recovered = false
    for (let attempt = 0; attempt < 50 && !recovered; attempt += 1) {
      try {
        recovered = await journal.runExclusive(async () => true)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    assert.equal(recovered, true)
  } finally {
    child?.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('journal exclusive run lock refuses a symlink without touching its target', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-lock-link-')))
  const path = join(root, 'resume.json')
  const target = join(root, 'outside')
  try {
    await chmod(root, 0o700)
    await writeFile(target, 'untouched', { mode: 0o600 })
    await symlink(target, `${path}.lock`)
    const journal = await createWorkbookRolloutJournal(path)
    await assert.rejects(journal.runExclusive(async () => 'must-not-run'),
      /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
    assert.equal(await readFile(target, 'utf8'), 'untouched')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('journal load rejects noncanonical bytes and same-inode or parent revisions', async () => {
  for (const kind of ['noncanonical', 'file-revision', 'parent-revision']) {
    const root = await realpath(await mkdtemp(join(tmpdir(), `bwm-journal-${kind}-`)))
    const path = join(root, 'resume.json')
    let restore = () => {}
    try {
      await chmod(root, 0o700)
      await writeFile(path, kind === 'noncanonical'
        ? JSON.stringify(initial, null, 2) : JSON.stringify(initial), { mode: 0o600 })
      const journal = await createWorkbookRolloutJournal(path)
      if (kind === 'file-revision') {
        const replacement = JSON.stringify({ ...initial, creatorId: 'stf_rollout_ownez' })
        assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(JSON.stringify(initial)))
        restore = await interceptNextHandleRead(async () => {
          const before = await lstat(path)
          await writeFile(path, replacement, { mode: 0o600 })
          assert.equal((await lstat(path)).ino, before.ino)
        })
      }
      if (kind === 'parent-revision') {
        restore = await interceptNextHandleRead(async () => {
          await writeFile(join(root, 'unexpected'), 'x', { mode: 0o600 })
        })
      }
      await assert.rejects(journal.load(), /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
    } finally {
      restore()
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('journal flags fail closed and a swapped held lock inode is never released', async () => {
  for (const fsConstants of [
    { O_DIRECTORY: 1, O_NOFOLLOW: undefined },
    { O_DIRECTORY: undefined, O_NOFOLLOW: 1 },
  ]) {
    assert.throws(() => validateWorkbookRolloutJournalPrivateFileFlags(fsConstants),
      /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-lock-swap-')))
  const path = join(root, 'resume.json')
  const lockPath = `${path}.lock`
  try {
    await chmod(root, 0o700)
    const journal = await createWorkbookRolloutJournal(path)
    await assert.rejects(journal.runExclusive(async () => {
      await rename(lockPath, `${lockPath}.held`)
      await writeFile(lockPath, 'workbook_rollout_lock.v1\n', { mode: 0o600 })
    }), /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
    assert.equal(await readFile(lockPath, 'utf8'), 'workbook_rollout_lock.v1\n')
    assert.equal(await journal.runExclusive(async () => 'replacement-lock-acquired'),
      'replacement-lock-acquired')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('journal refuses an unexpectedly exited lock helper and then reacquires', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-lock-exit-')))
  const path = join(root, 'resume.json')
  try {
    await chmod(root, 0o700)
    const journal = await createWorkbookRolloutJournal(path)
    await assert.rejects(journal.runExclusive(async () => {
      const helper = process._getActiveHandles().find((handle) => (
        handle?.constructor?.name === 'ChildProcess'
        && ['/usr/bin/lockf', '/usr/bin/flock'].includes(handle.spawnfile)
      ))
      assert.ok(helper)
      helper.kill('SIGKILL')
      await once(helper, 'exit')
    }), /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
    assert.equal(await journal.runExclusive(async () => 'reacquired'), 'reacquired')
  } finally { await rm(root, { recursive: true, force: true }) }
})
