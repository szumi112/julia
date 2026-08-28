import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { createWorkbookRolloutJournal } from '../../scripts/workbook-rollout-journal.mjs'

const initial = Object.freeze({
  schema: 'workbook_rollout_journal.v2',
  environment: 'staging',
  fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
  creatorId: 'stf_rollout_owner',
  phase: 'initialized',
  importIdentity: null,
  result: null,
})

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
    assert.equal(await first.runExclusive(async () => 'stale-file-reused'), 'stale-file-reused')
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
