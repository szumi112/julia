import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'

import {
  readPrivateAccessStorageState,
  validatePrivateAccessStorageStateFlags,
} from '../../scripts/workbook-historical-review.mjs'
import {
  readPrivateHistoricalReviewJson,
  writePrivateHistoricalReviewJson,
} from '../../scripts/workbook-historical-review-private.mjs'

const privateRoot = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-review-private-')))
  await chmod(root, 0o700)
  const directory = join(root, 'operator')
  await mkdir(directory, { mode: 0o700 })
  return { root, directory }
}

const accessStorageState = Object.freeze({ cookies: [], origins: [] })

async function writeAccessStorageState(path, value = accessStorageState) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

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

async function interceptHandleSync(ordinal, action) {
  const sample = await open(import.meta.filename, 'r')
  const prototype = Object.getPrototypeOf(sample)
  const original = prototype.sync
  await sample.close()
  let calls = 0
  prototype.sync = async function (...args) {
    const result = await original.apply(this, args)
    calls += 1
    if (calls === ordinal) await action()
    return result
  }
  return () => { prototype.sync = original }
}

async function interceptDirectoryStat(ordinal, action) {
  const sample = await open(import.meta.filename, 'r')
  const prototype = Object.getPrototypeOf(sample)
  const original = prototype.stat
  await sample.close()
  let calls = 0
  prototype.stat = async function (...args) {
    const stats = await original.apply(this, args)
    if (stats.isDirectory()) {
      calls += 1
      if (calls === ordinal) await action()
    }
    return stats
  }
  return () => { prototype.stat = original }
}

test('Access storage-state reader accepts pretty JSON from an absolute private path', async () => {
  const { directory } = await privateRoot()
  const path = join(directory, 'owner-session.json')
  await writeAccessStorageState(path)

  assert.deepEqual(await readPrivateAccessStorageState(path), accessStorageState)
})

test('Access storage-state flags fail closed without positive safety flags', () => {
  for (const fsConstants of [
    { O_DIRECTORY: 1, O_NOFOLLOW: undefined, O_RDONLY: 0 },
    { O_DIRECTORY: undefined, O_NOFOLLOW: 1, O_RDONLY: 0 },
    { O_DIRECTORY: 1, O_NOFOLLOW: 0, O_RDONLY: 0 },
    { O_DIRECTORY: 0, O_NOFOLLOW: 1, O_RDONLY: 0 },
    { O_DIRECTORY: 1, O_NOFOLLOW: -1, O_RDONLY: 0 },
    { O_DIRECTORY: -1, O_NOFOLLOW: 1, O_RDONLY: 0 },
    { O_DIRECTORY: 1, O_NOFOLLOW: 1.5, O_RDONLY: 0 },
    { O_DIRECTORY: 1.5, O_NOFOLLOW: 1, O_RDONLY: 0 },
  ]) {
    assert.throws(() => validatePrivateAccessStorageStateFlags(fsConstants),
      /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)
  }
})

test('Access storage-state reader refuses relative paths', async () => {
  const { directory } = await privateRoot()
  const path = join(directory, 'owner-session.json')
  await writeAccessStorageState(path)
  await assert.rejects(readPrivateAccessStorageState(relative(process.cwd(), path)),
    /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)
})

test('Access storage-state reader refuses permissive and symlinked parents', async () => {
  const permissive = await privateRoot()
  const permissivePath = join(permissive.directory, 'owner-session.json')
  await writeAccessStorageState(permissivePath)
  await chmod(permissive.directory, 0o750)
  await assert.rejects(readPrivateAccessStorageState(permissivePath),
    /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)

  const linked = await privateRoot()
  const target = await privateRoot()
  const targetPath = join(target.directory, 'owner-session.json')
  await writeAccessStorageState(targetPath)
  const linkedDirectory = join(linked.root, 'linked-operator')
  await symlink(target.directory, linkedDirectory)
  await assert.rejects(readPrivateAccessStorageState(
    join(linkedDirectory, 'owner-session.json'),
  ), /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)
})

test('Access storage-state reader refuses non-regular, symlinked, and permissive files', async () => {
  const privateArea = await privateRoot()
  const directoryPath = join(privateArea.directory, 'directory.json')
  await mkdir(directoryPath, { mode: 0o600 })
  await assert.rejects(readPrivateAccessStorageState(directoryPath),
    /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)

  const targetPath = join(privateArea.directory, 'target.json')
  await writeAccessStorageState(targetPath)
  const linkedPath = join(privateArea.directory, 'linked.json')
  await symlink(targetPath, linkedPath)
  await assert.rejects(readPrivateAccessStorageState(linkedPath),
    /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)

  await chmod(targetPath, 0o640)
  await assert.rejects(readPrivateAccessStorageState(targetPath),
    /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)
})

test('Access storage-state reader refuses a file path swapped after descriptor read', async () => {
  const privateArea = await privateRoot()
  const path = join(privateArea.directory, 'owner-session.json')
  const replacement = join(privateArea.directory, 'replacement.json')
  await writeAccessStorageState(path)
  await writeAccessStorageState(replacement, { cookies: [], origins: [{ origin: 'replacement' }] })
  const restore = await interceptNextHandleRead(async () => rename(replacement, path))
  try {
    await assert.rejects(readPrivateAccessStorageState(path),
      /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)
  } finally { restore() }
})

test('Access storage-state reader refuses a file revision after descriptor read', async () => {
  const privateArea = await privateRoot()
  const path = join(privateArea.directory, 'owner-session.json')
  await writeAccessStorageState(path)
  const restore = await interceptNextHandleRead(async () => {
    await writeAccessStorageState(path, { cookies: [{ name: 'changed' }], origins: [] })
  })
  try {
    await assert.rejects(readPrivateAccessStorageState(path),
      /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)
  } finally { restore() }
})

test('Access storage-state reader refuses a parent identity swap after descriptor read', async () => {
  const privateArea = await privateRoot()
  const path = join(privateArea.directory, 'owner-session.json')
  const movedDirectory = join(privateArea.root, 'moved-operator')
  await writeAccessStorageState(path)
  const restore = await interceptNextHandleRead(async () => {
    await rename(privateArea.directory, movedDirectory)
    await mkdir(privateArea.directory, { mode: 0o700 })
    await writeAccessStorageState(path)
  })
  try {
    await assert.rejects(readPrivateAccessStorageState(path),
      /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)
  } finally { restore() }
})

test('Access storage-state reader refuses a parent revision after descriptor read', async () => {
  const privateArea = await privateRoot()
  const path = join(privateArea.directory, 'owner-session.json')
  await writeAccessStorageState(path)
  const restore = await interceptNextHandleRead(async () => {
    await writeAccessStorageState(join(privateArea.directory, 'unexpected.json'))
  })
  try {
    await assert.rejects(readPrivateAccessStorageState(path),
      /^Error: WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED$/)
  } finally { restore() }
})

test('writes and reads canonical JSON once in a real 0700 directory with a 0600 file', async () => {
  const { directory } = await privateRoot()
  const path = join(directory, 'proposal.json')
  const value = { schema: 'synthetic.v1', count: 1, digest: 'a'.repeat(64) }
  await writePrivateHistoricalReviewJson(path, value)
  assert.deepEqual(await readPrivateHistoricalReviewJson(path), value)
  await assert.rejects(writePrivateHistoricalReviewJson(path, value),
    /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)
})

test('private review writer rejects a same-size post-link rewrite, cleans its inode, and retries', async () => {
  const { directory } = await privateRoot()
  const path = join(directory, 'proposal.json')
  const approved = { schema: 'synthetic.v1', count: 1 }
  const changed = JSON.stringify({ schema: 'synthetic.v1', count: 2 })
  assert.equal(changed.length, JSON.stringify(approved).length)
  const restore = await interceptHandleSync(2, async () => {
    await writeFile(path, changed, { mode: 0o600 })
    await chmod(path, 0o600)
  })
  try {
    await assert.rejects(writePrivateHistoricalReviewJson(path, approved),
      /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)
  } finally { restore() }
  await assert.rejects(lstat(path), (error) => error?.code === 'ENOENT')
  assert.deepEqual(await readdir(directory), [])

  await writePrivateHistoricalReviewJson(path, approved)
  assert.deepEqual(await readPrivateHistoricalReviewJson(path), approved)
})

test('private review writer never removes an attacker replacement on failed validation', async () => {
  const { directory } = await privateRoot()
  const path = join(directory, 'proposal.json')
  const displaced = join(directory, 'displaced.json')
  const attacker = '{"schema":"attacker.v1"}'
  const restore = await interceptHandleSync(2, async () => {
    await rename(path, displaced)
    await writeFile(path, attacker, { mode: 0o600 })
    await chmod(path, 0o600)
  })
  try {
    await assert.rejects(writePrivateHistoricalReviewJson(
      path, { schema: 'synthetic.v1', count: 1 },
    ), /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)
  } finally { restore() }
  assert.equal(await readFile(path, 'utf8'), attacker)

  await unlink(path)
  await unlink(displaced)
  await writePrivateHistoricalReviewJson(path, { schema: 'synthetic.v1', count: 1 })
})

test('private review writer rejects a parent revision between final descriptor and path fences', async () => {
  const { directory } = await privateRoot()
  const path = join(directory, 'proposal.json')
  const unexpected = join(directory, 'unexpected.json')
  const restore = await interceptDirectoryStat(2, async () => {
    await writeFile(unexpected, '{}', { mode: 0o600 })
    await chmod(unexpected, 0o600)
  })
  try {
    await assert.rejects(writePrivateHistoricalReviewJson(
      path, { schema: 'synthetic.v1', count: 1 },
    ), /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)
  } finally { restore() }
  await assert.rejects(lstat(path), (error) => error?.code === 'ENOENT')
  assert.deepEqual(await readdir(directory), ['unexpected.json'])

  await unlink(unexpected)
  await writePrivateHistoricalReviewJson(path, { schema: 'synthetic.v1', count: 1 })
})

test('private review JSON reader refuses a file path swapped after descriptor read', async () => {
  const { directory } = await privateRoot()
  const path = join(directory, 'proposal.json')
  const replacement = join(directory, 'replacement.json')
  await writePrivateHistoricalReviewJson(path, { schema: 'synthetic.v1', count: 1 })
  await writePrivateHistoricalReviewJson(replacement, { schema: 'synthetic.v1', count: 2 })
  let interceptedBytes
  const restore = await interceptNextHandleRead(async (bytes) => {
    interceptedBytes = bytes
    await rename(replacement, path)
  })
  try {
    await assert.rejects(readPrivateHistoricalReviewJson(path),
      /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)
    assert.equal(interceptedBytes.every((byte) => byte === 0), true)
  } finally { restore() }
})

test('private review JSON reader refuses an existing relative path', async () => {
  const { directory } = await privateRoot()
  const path = join(directory, 'proposal.json')
  await writePrivateHistoricalReviewJson(path, { schema: 'synthetic.v1', count: 1 })
  await assert.rejects(readPrivateHistoricalReviewJson(relative(process.cwd(), path)),
    /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)
})

test('private review JSON reader refuses file and parent revisions after descriptor read', async () => {
  const fileArea = await privateRoot()
  const filePath = join(fileArea.directory, 'proposal.json')
  await writePrivateHistoricalReviewJson(filePath, { schema: 'synthetic.v1', count: 1 })
  const restoreFile = await interceptNextHandleRead(async () => {
    await writeFile(filePath, '{"schema":"synthetic.v1","count":2}', { mode: 0o600 })
    await chmod(filePath, 0o600)
  })
  try {
    await assert.rejects(readPrivateHistoricalReviewJson(filePath),
      /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)
  } finally { restoreFile() }

  const parentArea = await privateRoot()
  const parentPath = join(parentArea.directory, 'proposal.json')
  await writePrivateHistoricalReviewJson(parentPath, { schema: 'synthetic.v1', count: 1 })
  const restoreParent = await interceptNextHandleRead(async () => {
    await writeFile(join(parentArea.directory, 'unexpected.json'), '{}', { mode: 0o600 })
  })
  try {
    await assert.rejects(readPrivateHistoricalReviewJson(parentPath),
      /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)
  } finally { restoreParent() }
})

test('private review file flags fail closed when no-follow or directory flags are absent', async () => {
  const { validateHistoricalReviewPrivateFileFlags } = await import(
    '../../scripts/workbook-historical-review-private.mjs'
  )
  assert.equal(typeof validateHistoricalReviewPrivateFileFlags, 'function')
  for (const fsConstants of [
    { O_DIRECTORY: 1, O_NOFOLLOW: undefined, O_RDONLY: 0 },
    { O_DIRECTORY: undefined, O_NOFOLLOW: 1, O_RDONLY: 0 },
    { O_DIRECTORY: 1, O_NOFOLLOW: 0, O_RDONLY: 0 },
    { O_DIRECTORY: 0, O_NOFOLLOW: 1, O_RDONLY: 0 },
    { O_DIRECTORY: 1, O_NOFOLLOW: -1, O_RDONLY: 0 },
    { O_DIRECTORY: -1, O_NOFOLLOW: 1, O_RDONLY: 0 },
    { O_DIRECTORY: 1, O_NOFOLLOW: 1.5, O_RDONLY: 0 },
    { O_DIRECTORY: 1.5, O_NOFOLLOW: 1, O_RDONLY: 0 },
  ]) {
    assert.throws(() => validateHistoricalReviewPrivateFileFlags(fsConstants),
      /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)
  }
})

test('refuses permissive parents/files and symlinked private directories', async () => {
  const permissive = await privateRoot()
  await chmod(permissive.directory, 0o755)
  await assert.rejects(writePrivateHistoricalReviewJson(
    join(permissive.directory, 'proposal.json'), { schema: 'synthetic.v1' },
  ), /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)

  const original = await privateRoot()
  const path = join(original.directory, 'proposal.json')
  await writePrivateHistoricalReviewJson(path, { schema: 'synthetic.v1' })
  await chmod(path, 0o640)
  await assert.rejects(readPrivateHistoricalReviewJson(path),
    /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)

  const linked = await privateRoot()
  const linkedDirectory = join(linked.root, 'linked')
  await symlink(original.directory, linkedDirectory)
  await assert.rejects(readPrivateHistoricalReviewJson(join(linkedDirectory, 'proposal.json')),
    /^Error: WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED$/)
})

test('review CLI refuses missing private mode and arguments without remote work', () => {
  for (const args of [[], ['--help']]) {
    const result = spawnSync(process.execPath, [
      'scripts/workbook-historical-review.mjs', ...args,
    ], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH },
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '{"status":"refused"}\n')
  }
})
