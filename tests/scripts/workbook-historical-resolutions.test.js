import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  assertHistoricalProjectionResolutionBinding,
  readHistoricalProjectionResolutions,
} from '../../scripts/workbook-historical-resolutions.mjs'

const FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const PLAN_DIGEST = `v1_${'A'.repeat(43)}`
const digest = (value) => createHash('sha256').update(value).digest('hex')

const decisions = Object.freeze(Array.from({ length: 1_992 }, (_, index) => Object.freeze({
  sourceRecordId: `wbs_review_${String(index + 1).padStart(4, '0')}`,
  kind: index < 86 ? 'classification' : 'service',
  classification: 'person',
  existingSubjectId: null,
  serviceId: 'zajecia',
  reviewContextDigest: digest(`synthetic-context-${index}`),
})))

const artifact = (overrides = {}) => {
  const value = {
    schema: 'historical_projection_resolutions.v1',
    environment: 'staging',
    centreId: 'centre_1',
    fingerprint: FINGERPRINT,
    artifactId: 'wba_review_one',
    importId: 'wbi_review_one',
    creatorId: 'stf_review_one',
    planDigest: PLAN_DIGEST,
    decisionCount: decisions.length,
    decisionDigest: digest(JSON.stringify(decisions)),
    decisions,
    ...overrides,
  }
  return value
}

const writePrivate = async (value = artifact()) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-historical-resolutions-')))
  await chmod(root, 0o700)
  const directory = join(root, 'private')
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, 'historical_projection_resolutions.v1.json')
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  await chmod(path, 0o600)
  return { root, directory, path }
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

const binding = Object.freeze({
  environment: 'staging', centreId: 'centre_1', fingerprint: FINGERPRINT,
  artifactId: 'wba_review_one', importId: 'wbi_review_one', creatorId: 'stf_review_one',
  planDigest: PLAN_DIGEST,
})

test('loads the exact canonical private 1,992-decision artifact and binds its opaque catalog', async () => {
  const { path } = await writePrivate()
  const loaded = await readHistoricalProjectionResolutions(path)
  assert.equal(loaded.fileSha256, digest(JSON.stringify(artifact())))
  assert.equal(loaded.artifact.decisionCount, 1_992)
  assert.equal(loaded.artifact.decisions.filter(({ kind }) => kind === 'classification').length, 86)
  assert.equal(loaded.artifact.decisions.filter(({ kind }) => kind === 'service').length, 1_906)
  assert.equal(assertHistoricalProjectionResolutionBinding({
    loaded, binding,
    catalog: decisions.map(({ sourceRecordId, kind }) => ({ sourceRecordId, kind })),
  }), loaded)
})

test('rejects defaults, wildcards, omissions, extras, stale bindings, and non-canonical decision order', async () => {
  const hostile = [
    { default: { classification: 'person' } },
    { wildcard: '*' },
    { decisions: decisions.slice(1), decisionCount: 1_991,
      decisionDigest: digest(JSON.stringify(decisions.slice(1))) },
    { decisions: [...decisions, decisions[0]], decisionCount: 1_993,
      decisionDigest: digest(JSON.stringify([...decisions, decisions[0]])) },
    { decisions: [decisions[1], decisions[0], ...decisions.slice(2)],
      decisionDigest: digest(JSON.stringify([decisions[1], decisions[0], ...decisions.slice(2)])) },
    { environment: 'production' },
    { fingerprint: '0'.repeat(64) },
    { decisionDigest: '0'.repeat(64) },
    (() => {
      const changed = decisions.map((decision, index) => index === 86
        ? { ...decision, serviceId: null } : decision)
      return { decisions: changed, decisionDigest: digest(JSON.stringify(changed)) }
    })(),
  ]
  for (const override of hostile) {
    const { path } = await writePrivate(artifact(override))
    await assert.rejects(readHistoricalProjectionResolutions(path),
      /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)
  }

  const { path } = await writePrivate()
  const loaded = await readHistoricalProjectionResolutions(path)
  for (const stale of [
    { ...binding, artifactId: 'wba_other' },
    { ...binding, importId: 'wbi_other' },
    { ...binding, creatorId: 'stf_other' },
    { ...binding, planDigest: `v1_${'B'.repeat(43)}` },
  ]) {
    assert.throws(() => assertHistoricalProjectionResolutionBinding({
      loaded, binding: stale,
      catalog: decisions.map(({ sourceRecordId, kind }) => ({ sourceRecordId, kind })),
    }), /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)
  }
  assert.throws(() => assertHistoricalProjectionResolutionBinding({
    loaded, binding,
    catalog: decisions.slice(0, -1).map(({ sourceRecordId, kind }) => ({ sourceRecordId, kind })),
  }), /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)
  assert.throws(() => assertHistoricalProjectionResolutionBinding({
    loaded: { ...loaded, fileSha256: '0'.repeat(64) }, binding,
    catalog: decisions.map(({ sourceRecordId, kind }) => ({ sourceRecordId, kind })),
  }), /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)
})

test('requires a regular 0600 file inside a real non-symlink 0700 directory', async () => {
  const permissive = await writePrivate()
  await chmod(permissive.path, 0o640)
  await assert.rejects(readHistoricalProjectionResolutions(permissive.path),
    /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)

  const publicParent = await writePrivate()
  await chmod(publicParent.directory, 0o755)
  await assert.rejects(readHistoricalProjectionResolutions(publicParent.path),
    /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)

  const original = await writePrivate()
  const linkedRoot = await realpath(await mkdtemp(join(
    tmpdir(), 'bwm-historical-resolutions-link-',
  )))
  await chmod(linkedRoot, 0o700)
  const linkedDirectory = join(linkedRoot, 'private')
  await symlink(original.directory, linkedDirectory)
  await assert.rejects(readHistoricalProjectionResolutions(join(
    linkedDirectory, 'historical_projection_resolutions.v1.json',
  )), /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)
})

test('resolution artifact reader refuses an existing relative private path', async () => {
  const { path } = await writePrivate()
  await assert.rejects(readHistoricalProjectionResolutions(relative(process.cwd(), path)),
    /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)
})

test('resolution artifact reader refuses file swaps and parent revisions after descriptor read', async () => {
  const swapped = await writePrivate()
  const replacement = join(swapped.directory, 'replacement.json')
  await writeFile(replacement, JSON.stringify(artifact({ artifactId: 'wba_review_two' })), {
    mode: 0o600,
  })
  await chmod(replacement, 0o600)
  let interceptedBytes
  const restoreFile = await interceptNextHandleRead(async (bytes) => {
    interceptedBytes = bytes
    await rename(replacement, swapped.path)
  })
  try {
    await assert.rejects(readHistoricalProjectionResolutions(swapped.path),
      /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)
    assert.equal(interceptedBytes.every((byte) => byte === 0), true)
  } finally { restoreFile() }

  const revised = await writePrivate()
  const restoreParent = await interceptNextHandleRead(async () => {
    await writeFile(join(revised.directory, 'unexpected.json'), '{}', { mode: 0o600 })
  })
  try {
    await assert.rejects(readHistoricalProjectionResolutions(revised.path),
      /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)
  } finally { restoreParent() }
})

test('resolution artifact flags fail closed when no-follow or directory flags are absent', async () => {
  const { validateHistoricalResolutionPrivateFileFlags } = await import(
    '../../scripts/workbook-historical-resolutions.mjs'
  )
  assert.equal(typeof validateHistoricalResolutionPrivateFileFlags, 'function')
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
    assert.throws(() => validateHistoricalResolutionPrivateFileFlags(fsConstants),
      /^Error: WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED$/)
  }
})
