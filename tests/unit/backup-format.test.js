import assert from 'node:assert/strict'
import test from 'node:test'
import fixture from '../fixtures/backup-format-v1.json' with { type: 'json' }
import {
  backupObjectKeys, canonicalJson, expectedObjectMetadata, parseCanonicalManifest,
} from '../../worker/operations/backup-format.js'

const invalid = (operation) => assert.throws(operation, (error) => error?.message === 'BACKUP_MANIFEST_INVALID')
const bytes = (value) => new Uint8Array(Buffer.from(value))
const raw = (value) => new Uint8Array(Buffer.from(value, 'base64url'))
const valid = () => structuredClone(fixture.manifest)
const canonical = (value) => canonicalJson(value)

test('canonicalJson serializes fixture scalars, arrays, and recursively ordered objects', () => {
  for (const entry of fixture.canonicalCases) assert.equal(canonical(entry.value), entry.json)
})

test('canonicalJson rejects non-JSON, hostile, and prototype-polluting values without invoking accessors', () => {
  const sparse = []; sparse[1] = 1
  const cyclic = {}; cyclic.self = cyclic
  let invoked = false
  const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get() { invoked = true; return 1 } })
  const nonEnumerable = { value: 1 }; Object.defineProperty(nonEnumerable, 'hidden', { value: 2 })
  const hostile = new Proxy({}, { ownKeys() { throw new Error('marker') } })
  for (const value of [undefined, Symbol('x'), 1n, () => {}, new Number(1), Infinity, NaN, new Date(), new Uint8Array(1), Object.create(null), sparse, cyclic, accessor, nonEnumerable, { [Symbol('x')]: 1 }, hostile, { __proto__: null, prototype: 1 }, JSON.parse('{"constructor":1}')]) invalid(() => canonical(value))
  assert.equal(invoked, false)
  const repeated = { one: { value: 1 } }; repeated.two = repeated.one
  assert.equal(canonical(repeated), '{"one":{"value":1},"two":{"value":1}}')
})

test('canonicalJson uses one audited proxy key and descriptor snapshot', () => {
  let keyReads = 0
  const changingKeys = new Proxy({ value: 1 }, {
    ownKeys(target) { return ++keyReads === 1 ? Reflect.ownKeys(target) : [] },
  })
  assert.equal(canonical(changingKeys), '{"value":1}')
  let lengthReads = 0
  const changingLength = new Proxy([1], {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'length' && ++lengthReads > 1) throw new Error('marker')
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  assert.equal(canonical(changingLength), '[1]')
})

test('backupObjectKeys accepts exact IDs and real months and rejects hostile shapes', () => {
  assert.deepEqual(backupObjectKeys({ backupId: fixture.manifest.backupId, localMonth: fixture.manifest.localMonth }), fixture.objectKeys)
  assert.deepEqual(backupObjectKeys({ backupId: `bkp_${'a'.repeat(124)}`, localMonth: '2000-02' }), { objectKey: `backups/v1/2000/02/bkp_${'a'.repeat(124)}.sql`, manifestKey: `backups/v1/2000/02/bkp_${'a'.repeat(124)}.manifest.json` })
  const accessor = {}; Object.defineProperty(accessor, 'backupId', { enumerable: true, get() { throw new Error('marker') } }); accessor.localMonth = '2026-02'
  for (const value of [null, {}, accessor, { backupId: 'bkp_x', localMonth: '2026-02', extra: true }, { backupId: 'bkp_x', localMonth: '2026-02', [Symbol('x')]: 1 }, Object.create({ backupId: 'bkp_x', localMonth: '2026-02' }), { backupId: 'bkp_x', localMonth: '2026-00' }, { backupId: 'bkp_x', localMonth: '2026-2' }, { backupId: 'bad', localMonth: '2026-02' }, { backupId: `bkp_${'a'.repeat(125)}`, localMonth: '2026-02' }]) invalid(() => backupObjectKeys(value))
})

test('parseCanonicalManifest accepts the shared canonical bytes with one JSON.parse call', () => {
  const originalParse = JSON.parse
  let calls = 0
  JSON.parse = (...args) => { calls += 1; return originalParse(...args) }
  try {
    assert.deepEqual(parseCanonicalManifest(raw(fixture.canonicalManifestBase64Url)), fixture.manifest)
  } finally { JSON.parse = originalParse }
  assert.equal(calls, 1)
})

test('parseCanonicalManifest rejects invalid bytes and noncanonical JSON aliases', () => {
  for (const value of Object.values(fixture.invalidRawBytes)) invalid(() => parseCanonicalManifest(raw(value)))
  invalid(() => parseCanonicalManifest(bytes('{')))
  for (const value of [new ArrayBuffer(1), new DataView(new ArrayBuffer(1)), new Uint16Array(1), 'bytes', []]) invalid(() => parseCanonicalManifest(value))
})

test('fixture raw aliases preserve the complete manifest schema before byte equality rejection', () => {
  for (const name of ['whitespace', 'newline', 'rootDuplicate', 'nestedDuplicate', 'reorderedRoot', 'nestedReordered', 'alternateNumber', 'textualEscape']) {
    assert.deepEqual(JSON.parse(new TextDecoder().decode(raw(fixture.invalidRawBytes[name]))), fixture.manifest, name)
  }
  const bom = raw(fixture.invalidRawBytes.bom)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bom.subarray(3))), fixture.manifest)
  const malformed = JSON.parse(new TextDecoder().decode(raw(fixture.invalidRawBytes.malformedUtf8)))
  assert.equal(malformed.objectKey, fixture.manifest.objectKey)
  assert.match(malformed.objectEtag, /\uFFFD/)
})

test('parseCanonicalManifest validates every schema field and relationship', () => {
  const changes = [
    (m) => delete m.format, (m) => { m.extra = true }, (m) => { m.format = 'other' },
    (m) => { m.createdAt = '2026-08-03T12:34:56Z' }, (m) => { m.createdAt = '2026-02-30T12:34:56.789Z' }, (m) => { m.localDay = '2026-02-30' },
    (m) => { m.localMonth = '2026-07' }, (m) => { m.objectKey = 'backups/v1/2026/08/other.sql' },
    (m) => { m.retentionClass = 'yearly' }, (m) => { m.objectSize = -1 }, (m) => { m.objectSize = 1.5 },
    (m) => { m.objectSize = Number.MAX_SAFE_INTEGER + 1 }, (m) => { m.wrappedSsecKey = {} },
    (m) => { m.wrappedSsecKey.extra = true }, (m) => { m.wrappedSsecKey.algorithm = 'A128GCM' },
    (m) => { m.wrappedSsecKey.kekVersion = 0 }, (m) => { m.wrappedSsecKey.kekVersion = 1.5 }, (m) => { m.wrappedSsecKey.kekVersion = Number.MAX_SAFE_INTEGER + 1 },
    (m) => { m.wrappedSsecKey.nonce = 'AAECAwQFBgcICQo' }, (m) => { m.wrappedSsecKey.nonce = `${fixture.publicEncoding.nonce}=` }, (m) => { m.wrappedSsecKey.ciphertext = `${fixture.publicEncoding.ciphertext}A` },
    (m) => { m.wrappedSsecKey.ciphertext = `${fixture.publicEncoding.ciphertext}=` }, (m) => { m.wrappedSsecKey.ciphertext = fixture.publicEncoding.ciphertext.replace(/.$/, '+') },
  ]
  for (const change of changes) { const manifest = valid(); change(manifest); invalid(() => parseCanonicalManifest(bytes(canonical(manifest)))) }
})

test('parseCanonicalManifest rejects every missing and wrong root or wrapped-key field', () => {
  const wrongRoot = {
    format: 1,
    backupId: 'wrong',
    createdAt: 'wrong',
    localDay: 'wrong',
    localMonth: 'wrong',
    retentionClass: 'wrong',
    objectKey: 'wrong',
    objectEtag: 1,
    objectSize: '1',
    atBookmark: 1,
    wrappedSsecKey: 1,
  }
  const wrongWrapped = { algorithm: 'wrong', kekVersion: '1', nonce: 'wrong', ciphertext: 'wrong' }
  for (const field of Object.keys(valid())) {
    const manifest = valid(); delete manifest[field]
    invalid(() => parseCanonicalManifest(bytes(canonical(manifest))))
  }
  for (const [field, value] of Object.entries(wrongRoot)) {
    const manifest = valid(); manifest[field] = value
    invalid(() => parseCanonicalManifest(bytes(canonical(manifest))))
  }
  for (const field of Object.keys(valid().wrappedSsecKey)) {
    const manifest = valid(); delete manifest.wrappedSsecKey[field]
    invalid(() => parseCanonicalManifest(bytes(canonical(manifest))))
  }
  for (const [field, value] of Object.entries(wrongWrapped)) {
    const manifest = valid(); manifest.wrappedSsecKey[field] = value
    invalid(() => parseCanonicalManifest(bytes(canonical(manifest))))
  }
})

test('parseCanonicalManifest enforces opaque UTF-8 bounds and safe characters', () => {
  for (const field of ['objectEtag', 'atBookmark']) for (const value of ['', fixture.opaqueBoundaries.tooLong, ' bad', 'bad ', 'bad\nvalue', 'bad\u200Evalue', 'e\u0301']) {
    const manifest = valid(); manifest[field] = value; invalid(() => parseCanonicalManifest(bytes(canonical(manifest))))
  }
  for (const value of [fixture.opaqueBoundaries.one, fixture.opaqueBoundaries.max]) {
    const manifest = valid(); manifest.objectEtag = value; manifest.atBookmark = value
    assert.deepEqual(parseCanonicalManifest(bytes(canonical(manifest))), manifest)
  }
  assert.equal(new TextEncoder().encode(fixture.opaqueBoundaries.multiByteMax).byteLength, 1024)
  assert.equal(new TextEncoder().encode(fixture.opaqueBoundaries.multiByteTooLong).byteLength, 1025)
  for (const value of [fixture.opaqueBoundaries.multiByteMax, fixture.opaqueBoundaries.multiByteTooLong]) {
    const manifest = valid(); manifest.objectEtag = value; manifest.atBookmark = value
    if (value === fixture.opaqueBoundaries.multiByteMax) assert.deepEqual(parseCanonicalManifest(bytes(canonical(manifest))), manifest)
    else invalid(() => parseCanonicalManifest(bytes(canonical(manifest))))
  }
})

test('expectedObjectMetadata returns exact metadata only for complete canonical manifests', () => {
  assert.deepEqual(expectedObjectMetadata(valid()), fixture.metadata)
  const partial = valid(); delete partial.objectKey
  invalid(() => expectedObjectMetadata(partial))
})
