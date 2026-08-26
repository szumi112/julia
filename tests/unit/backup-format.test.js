import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import fixture from '../fixtures/backup-format-v1.json' with { type: 'json' }
import {
  backupObjectKeys, canonicalJson, createBackupManifest, expectedObjectMetadata, openBackupManifest, parseCanonicalManifest,
} from '../../worker/operations/backup-format.js'
import * as backupFormat from '../../worker/operations/backup-format.js'

const invalid = (operation) => assert.throws(operation, (error) => error?.message === 'BACKUP_MANIFEST_INVALID')
const bytes = (value) => new Uint8Array(Buffer.from(value))
const raw = (value) => new Uint8Array(Buffer.from(value, 'base64url'))
const valid = () => structuredClone(fixture.manifest)
const canonical = (value) => canonicalJson(value)
const derive = (seed) => Uint8Array.from({ length: 32 }, (_, index) => (seed + (index * 29)) & 0xff)
const importKek = (seed) => crypto.subtle.importKey('raw', derive(seed), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
const importAes = (seed, { length = 256, extractable = false, usages = ['encrypt', 'decrypt'] } = {}) => crypto.subtle.importKey(
  'raw', derive(seed).subarray(0, length / 8), { name: 'AES-GCM', length }, extractable, usages,
)
const encode = (value) => Buffer.from(value).toString('base64url')
const manifestBytes = (mutate) => {
  const manifest = valid()
  mutate(manifest)
  return bytes(canonical(manifest))
}
const errorText = async (operation) => {
  try {
    await operation()
    assert.fail('expected rejection')
  } catch (error) {
    return `${error?.name}:${error?.message}`
  }
}
const cryptoFailed = async (operation) => await assert.rejects(operation, (error) => error?.message === 'BACKUP_CRYPTO_FAILED')
const manifestInvalid = async (operation) => await assert.rejects(operation, (error) => error?.message === 'BACKUP_MANIFEST_INVALID')
const keyring = async ({ active = 1, versions = { 1: fixture.publicDerivationSeeds.backupKek } } = {}) => Object.freeze({
  activeBackupKekVersion: active,
  backupKekVersions: Object.freeze(Object.keys(versions).map(Number)),
  getBackupKek: async (version) => versions[version] === undefined ? null : await importKek(versions[version]),
})

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

test('backup crypto has the exact six-name public surface', () => {
  assert.deepEqual(Object.keys(backupFormat).sort(), [
    'backupObjectKeys', 'canonicalJson', 'createBackupManifest', 'expectedObjectMetadata', 'openBackupManifest', 'parseCanonicalManifest',
  ])
})

test('createBackupManifest produces the shared deterministic authenticated vector without changing the caller key', async () => {
  const callerKey = derive(fixture.publicDerivationSeeds.rawSsecKey)
  const original = callerKey.slice()
  const nonce = raw(fixture.publicEncoding.nonce)
  const result = await createBackupManifest({ facts: structuredClone(fixture.facts), rawSsecKey: callerKey, keyring: await keyring(), nonceFactory: () => nonce })
  assert.deepEqual(Reflect.ownKeys(result).sort(), ['bytes', 'databaseFields', 'manifest'])
  assert.deepEqual(result.manifest, fixture.manifest)
  assert.equal(new TextDecoder().decode(result.bytes), fixture.canonicalManifestJson)
  assert.deepEqual([...result.bytes], [...raw(fixture.canonicalManifestBase64Url)])
  assert.deepEqual(result.databaseFields, fixture.databaseFields)
  assert.deepEqual(expectedObjectMetadata(result.manifest), fixture.metadata)
  assert.deepEqual([...callerKey], [...original])
  assert.deepEqual([...nonce], Array(12).fill(0))
})

test('openBackupManifest authenticates the shared vector and returns a fresh mutable key', async () => {
  const first = await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: await keyring() })
  const second = await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: await keyring() })
  assert.deepEqual(Reflect.ownKeys(first).sort(), ['manifest', 'rawSsecKey'])
  assert.deepEqual(first.manifest, fixture.manifest)
  assert.equal(first.rawSsecKey instanceof Uint8Array, true)
  assert.equal(first.rawSsecKey.byteLength, 32)
  assert.deepEqual([...first.rawSsecKey], [...derive(fixture.publicDerivationSeeds.rawSsecKey)])
  assert.notEqual(first.rawSsecKey, second.rawSsecKey)
  first.rawSsecKey[0] ^= 0xff
  assert.equal(second.rawSsecKey[0], derive(fixture.publicDerivationSeeds.rawSsecKey)[0])
})

test('creation zeroes retained internal encryption buffers while preserving the caller key', async () => {
  const callerKey = derive(73)
  const callerCopy = callerKey.slice()
  const transferredNonce = raw(fixture.publicEncoding.nonce)
  const encryptedResult = new Uint8Array(48); encryptedResult.fill(91)
  let captured
  const originalEncrypt = crypto.subtle.encrypt
  try {
    crypto.subtle.encrypt = async (algorithm, _key, plaintext) => {
      captured = { iv: algorithm.iv, aad: algorithm.additionalData, plaintext }
      return encryptedResult.buffer
    }
    const result = await createBackupManifest({ facts: fixture.facts, rawSsecKey: callerKey, keyring: await keyring(), nonceFactory: () => transferredNonce })
    assert.deepEqual(Reflect.ownKeys(result).sort(), ['bytes', 'databaseFields', 'manifest'])
  } finally {
    crypto.subtle.encrypt = originalEncrypt
  }
  assert.deepEqual([...callerKey], [...callerCopy])
  for (const value of [transferredNonce, captured.iv, captured.aad, captured.plaintext, encryptedResult]) {
    assert.deepEqual([...value], Array(value.byteLength).fill(0))
  }
})

test('opening zeroes retained decoded buffers but transfers successful plaintext ownership', async () => {
  const standardRing = await keyring()
  const originalDecrypt = crypto.subtle.decrypt
  let captured
  let opened
  try {
    crypto.subtle.decrypt = function (algorithm, key, ciphertext) {
      captured = { iv: algorithm.iv, aad: algorithm.additionalData, ciphertext }
      return originalDecrypt.call(this, algorithm, key, ciphertext)
    }
    opened = await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: standardRing })
  } finally {
    crypto.subtle.decrypt = originalDecrypt
  }
  for (const value of [captured.iv, captured.aad, captured.ciphertext]) {
    assert.deepEqual([...value], Array(value.byteLength).fill(0))
  }
  assert.equal(opened.rawSsecKey instanceof Uint8Array, true)
  assert.equal(opened.rawSsecKey.byteLength, 32)
  assert.equal(opened.rawSsecKey.some((value) => value !== 0), true)
  const first = opened.rawSsecKey[0]
  opened.rawSsecKey[0] ^= 0xff
  assert.notEqual(opened.rawSsecKey[0], first)

  const shortPlaintext = new Uint8Array(31); shortPlaintext.fill(57)
  try {
    crypto.subtle.decrypt = async () => shortPlaintext.buffer
    await manifestInvalid(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: standardRing }))
  } finally {
    crypto.subtle.decrypt = originalDecrypt
  }
  assert.deepEqual([...shortPlaintext], Array(31).fill(0))
})

test('backup crypto uses exactly the active and declared key version without fallback', async () => {
  const used = []
  const one = await importKek(fixture.publicDerivationSeeds.backupKek)
  const ring = Object.freeze({ activeBackupKekVersion: 1, backupKekVersions: Object.freeze([2, 1]), getBackupKek(version) { used.push(version); return version === 1 ? one : null } })
  await createBackupManifest({ facts: structuredClone(fixture.facts), rawSsecKey: derive(fixture.publicDerivationSeeds.rawSsecKey), keyring: ring, nonceFactory: () => raw(fixture.publicEncoding.nonce) })
  assert.deepEqual(used, [1])
  used.length = 0
  await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ring })
  assert.deepEqual(used, [1])
})

test('backup crypto closes creation and opening failures without native async markers', async () => {
  const source = structuredClone(fixture.facts)
  const standardRing = await keyring()
  const invalidActiveRing = await keyring({ active: 0 })
  const missingRing = await keyring({ versions: {} })
  const hostile = {}; Object.defineProperty(hostile, 'backupId', { enumerable: true, get() { throw new Error('marker') } })
  for (const facts of [null, hostile, { ...source, extra: true }, { ...source, objectKey: 'wrong' }]) {
    await cryptoFailed(() => createBackupManifest({ facts, rawSsecKey: derive(1), keyring: null, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
  }
  for (const input of [new Uint8Array(31), new Uint16Array(16), new ArrayBuffer(32)]) {
    await cryptoFailed(() => createBackupManifest({ facts: source, rawSsecKey: input, keyring: standardRing, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
  }
  await cryptoFailed(() => createBackupManifest({ facts: source, rawSsecKey: derive(1), keyring: invalidActiveRing, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
  await cryptoFailed(() => createBackupManifest({ facts: source, rawSsecKey: derive(1), keyring: standardRing, nonceFactory: () => new Uint8Array(11) }))
  await manifestInvalid(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: missingRing }))
  const tampered = structuredClone(fixture.manifest); tampered.objectEtag = 'public-etag-v2'
  await manifestInvalid(() => openBackupManifest({ bytes: bytes(canonical(tampered)), keyring: standardRing }))
})

test('backup crypto rejects non-production AES key shapes before Web Crypto', async () => {
  const hmac = await crypto.subtle.importKey('raw', derive(7), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const { publicKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const keys = [
    await importAes(7, { length: 128 }),
    await importAes(7, { length: 192 }),
    await importAes(7, { extractable: true }),
    await importAes(7, { usages: ['encrypt'] }),
    await importAes(7, { usages: ['decrypt'] }),
    hmac,
    publicKey,
  ]
  let encryptCalls = 0
  let decryptCalls = 0
  const originalEncrypt = crypto.subtle.encrypt
  const originalDecrypt = crypto.subtle.decrypt
  try {
    crypto.subtle.encrypt = function (...args) { encryptCalls += 1; return originalEncrypt.call(this, ...args) }
    crypto.subtle.decrypt = function (...args) { decryptCalls += 1; return originalDecrypt.call(this, ...args) }
    for (const key of keys) {
      const ring = { activeBackupKekVersion: 1, getBackupKek: () => key }
      await cryptoFailed(() => createBackupManifest({ facts: structuredClone(fixture.facts), rawSsecKey: derive(3), keyring: ring, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
      await manifestInvalid(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ring }))
    }
  } finally {
    crypto.subtle.encrypt = originalEncrypt
    crypto.subtle.decrypt = originalDecrypt
  }
  assert.equal(encryptCalls, 0)
  assert.equal(decryptCalls, 0)
  const reversed = await importAes(fixture.publicDerivationSeeds.backupKek, { usages: ['decrypt', 'encrypt'] })
  const ring = { activeBackupKekVersion: 1, getBackupKek: () => reversed }
  assert.deepEqual((await createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(fixture.publicDerivationSeeds.rawSsecKey), keyring: ring, nonceFactory: () => raw(fixture.publicEncoding.nonce) })).manifest, fixture.manifest)
  assert.deepEqual((await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ring })).manifest, fixture.manifest)
})

test('backup crypto rejects every inexact outer object without invoking accessors or traps', async () => {
  const standardRing = await keyring()
  const createBase = { facts: structuredClone(fixture.facts), rawSsecKey: derive(3), keyring: standardRing, nonceFactory: () => raw(fixture.publicEncoding.nonce) }
  const openBase = { bytes: raw(fixture.canonicalManifestBase64Url), keyring: standardRing }
  for (const field of Object.keys(createBase)) {
    const input = { ...createBase }; delete input[field]
    await cryptoFailed(() => createBackupManifest(input))
  }
  for (const field of Object.keys(openBase)) {
    const input = { ...openBase }; delete input[field]
    await manifestInvalid(() => openBackupManifest(input))
  }
  let invoked = false
  const createAccessor = { ...createBase }
  Object.defineProperty(createAccessor, 'facts', { enumerable: true, get() { invoked = true; throw new Error('OUTER_ACCESSOR') } })
  const openAccessor = { ...openBase }
  Object.defineProperty(openAccessor, 'bytes', { enumerable: true, get() { invoked = true; throw new Error('OUTER_ACCESSOR') } })
  const createInputs = [
    null, { ...createBase, extra: true }, { ...createBase, [Symbol('outer')]: true }, Object.create(createBase), createAccessor,
    new Proxy(createBase, { ownKeys() { throw new Error('OUTER_PROXY') } }),
  ]
  const openInputs = [
    null, { ...openBase, extra: true }, { ...openBase, [Symbol('outer')]: true }, Object.create(openBase), openAccessor,
    new Proxy(openBase, { ownKeys() { throw new Error('OUTER_PROXY') } }),
  ]
  for (const input of createInputs) await cryptoFailed(() => createBackupManifest(input))
  for (const input of openInputs) await manifestInvalid(() => openBackupManifest(input))
  assert.equal(invoked, false)
})

test('creation audits the exact facts object before nonce creation or key lookup', async () => {
  const facts = structuredClone(fixture.facts)
  let nonceCalls = 0
  let keyCalls = 0
  let invoked = false
  const ring = { activeBackupKekVersion: 1, getBackupKek() { keyCalls += 1; return null } }
  const run = (value) => createBackupManifest({ facts: value, rawSsecKey: derive(3), keyring: ring, nonceFactory() { nonceCalls += 1; return raw(fixture.publicEncoding.nonce) } })
  const invalidFacts = [null, { ...facts, extra: true }, { ...facts, [Symbol('fact')]: true }, Object.create(facts)]
  for (const mutate of [
    (value) => { value.format = 'bwm-d1-sql-v2' }, (value) => { value.backupId = 'wrong' },
    (value) => { value.createdAt = '2026-08-03T12:34:56Z' }, (value) => { value.localDay = '2026-09-01' },
    (value) => { value.localMonth = '2026-09' }, (value) => { value.retentionClass = 'yearly' },
    (value) => { value.objectKey = 'wrong' }, (value) => { value.objectEtag = '' },
    (value) => { value.objectSize = -1 }, (value) => { value.atBookmark = '' },
  ]) { const value = { ...facts }; mutate(value); invalidFacts.push(value) }
  for (const field of Object.keys(facts)) {
    const value = { ...facts }; delete value[field]; invalidFacts.push(value)
  }
  const nonEnumerable = { ...facts }; Object.defineProperty(nonEnumerable, 'backupId', { value: facts.backupId, enumerable: false }); invalidFacts.push(nonEnumerable)
  const accessor = { ...facts }; Object.defineProperty(accessor, 'backupId', { enumerable: true, get() { invoked = true; throw new Error('FACT_ACCESSOR') } }); invalidFacts.push(accessor)
  invalidFacts.push(new Proxy(facts, { ownKeys() { throw new Error('FACT_PROXY') } }))
  for (const value of invalidFacts) await cryptoFailed(() => run(value))
  assert.equal(invoked, false)
  assert.equal(nonceCalls, 0)
  assert.equal(keyCalls, 0)
})

test('backup crypto audits keyring descriptors and closes throwing or rejected lookup calls', async () => {
  const goodKey = await importKek(fixture.publicDerivationSeeds.backupKek)
  let invoked = false
  const accessor = { activeBackupKekVersion: 1 }
  Object.defineProperty(accessor, 'getBackupKek', { enumerable: true, get() { invoked = true; throw new Error('KEYRING_ACCESSOR') } })
  const nonEnumerable = { activeBackupKekVersion: 1 }
  Object.defineProperty(nonEnumerable, 'getBackupKek', { enumerable: false, value: () => goodKey })
  const inherited = Object.create({ getBackupKek: () => goodKey }); inherited.activeBackupKekVersion = 1
  const hostile = new Proxy({ activeBackupKekVersion: 1, getBackupKek: () => goodKey }, { ownKeys() { throw new Error('KEYRING_PROXY') } })
  for (const ring of [null, accessor, nonEnumerable, inherited, hostile, { activeBackupKekVersion: 1, getBackupKek: () => goodKey, [Symbol('ring')]: true }, { activeBackupKekVersion: 1, getBackupKek: null }]) {
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: ring, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
    await manifestInvalid(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ring }))
  }
  for (const activeBackupKekVersion of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: { activeBackupKekVersion, getBackupKek: () => goodKey }, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
  }
  for (const getBackupKek of [() => { throw new Error('LOOKUP_THROW') }, async () => { throw new DOMException('LOOKUP_REJECT') }]) {
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: { activeBackupKekVersion: 1, getBackupKek }, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
    await manifestInvalid(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: { activeBackupKekVersion: 999, getBackupKek } }))
  }
  assert.equal(invoked, false)
  const ignoresActive = { activeBackupKekVersion: 0, backupKekVersions: 'ignored', getBackupKek: () => goodKey }
  assert.deepEqual((await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ignoresActive })).manifest, fixture.manifest)
})

test('creation uses active version once while opening uses only a different declared version', async () => {
  const calls = []
  const one = await importKek(fixture.publicDerivationSeeds.backupKek)
  const two = await importKek(151)
  const ring = { activeBackupKekVersion: 2, backupKekVersions: [2, 1], getBackupKek(version) { calls.push(version); return version === 1 ? one : two } }
  const created = await createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: ring, nonceFactory: () => raw(fixture.publicEncoding.nonce) })
  assert.equal(created.manifest.wrappedSsecKey.kekVersion, 2)
  assert.deepEqual(calls, [2])
  calls.length = 0
  await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ring })
  assert.deepEqual(calls, [1])
  calls.length = 0
  const noFallback = { activeBackupKekVersion: 2, backupKekVersions: [2], getBackupKek(version) { calls.push(version); return null } }
  await manifestInvalid(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: noFallback }))
  assert.deepEqual(calls, [1])
})

test('creation rejects raw-key and nonce variants while preserving caller bytes and zeroing transferred nonces', async () => {
  const standardRing = await keyring()
  const detached = new Uint8Array(32)
  structuredClone(detached.buffer, { transfer: [detached.buffer] })
  for (const rawSsecKey of [null, new ArrayBuffer(32), new DataView(new ArrayBuffer(32)), new Uint16Array(16), new Uint8Array(31), new Uint8Array(33), detached]) {
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey, keyring: standardRing, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
  }
  for (const returned of [new Uint8Array(0), new Uint8Array(11), new Uint8Array(13)]) {
    returned.fill(9)
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory: () => returned }))
    assert.deepEqual([...returned], Array(returned.length).fill(0))
  }
  for (const returned of [null, new ArrayBuffer(12), new Uint16Array(6), 'nonce']) {
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory: () => returned }))
  }
  let calls = 0
  await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory(...args) { calls += 1; assert.equal(args.length, 0); throw new Error('NONCE_THROW') } }))
  assert.equal(calls, 1)
  const callerKey = derive(77)
  const original = callerKey.slice()
  const nonce = raw(fixture.publicEncoding.nonce)
  const rejectingRing = { activeBackupKekVersion: 1, getBackupKek: async () => { throw new Error('AFTER_COPY') } }
  await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: callerKey, keyring: rejectingRing, nonceFactory: () => nonce }))
  assert.deepEqual([...callerKey], [...original])
  assert.deepEqual([...nonce], Array(12).fill(0))
  const bufferKey = Buffer.from(derive(fixture.publicDerivationSeeds.rawSsecKey))
  const bufferCopy = Buffer.from(bufferKey)
  const bufferNonce = Buffer.from(raw(fixture.publicEncoding.nonce))
  assert.deepEqual((await createBackupManifest({ facts: fixture.facts, rawSsecKey: bufferKey, keyring: standardRing, nonceFactory: () => bufferNonce })).manifest, fixture.manifest)
  assert.deepEqual(bufferKey, bufferCopy)
  assert.deepEqual(bufferNonce, Buffer.alloc(12))
})

test('creation observes invalid nonce promises and zeroes a resolved Uint8Array', async () => {
  const standardRing = await keyring()
  const pending = new Promise(() => {})
  let prompt
  try {
    prompt = await Promise.race([
      createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory: () => pending }),
      Promise.resolve('still-pending'),
    ])
  } catch (error) {
    prompt = error?.message
  }
  assert.equal(prompt, 'BACKUP_CRYPTO_FAILED')
  const resolvedNonce = new Uint8Array(12); resolvedNonce.fill(43)
  let resolveNonce
  const resolving = new Promise((resolve) => { resolveNonce = resolve })
  await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory: () => resolving }))
  resolveNonce(resolvedNonce)
  await Promise.resolve()
  assert.deepEqual([...resolvedNonce], Array(12).fill(0))
  const unhandled = []
  const listener = (error) => { unhandled.push(error) }
  process.on('unhandledRejection', listener)
  try {
    let rejectNonce
    const rejecting = new Promise((_resolve, reject) => { rejectNonce = reject })
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory: () => rejecting }))
    rejectNonce(new Error('ASYNC_NONCE_MARKER'))
    await Promise.resolve()
    await Promise.resolve()
  } finally {
    process.off('unhandledRejection', listener)
  }
  assert.deepEqual(unhandled, [])
})

test('async Web Crypto failures and wrong plaintext lengths remain closed and zero transferred inputs', async () => {
  const standardRing = await keyring()
  const originalEncrypt = crypto.subtle.encrypt
  const callerKey = derive(88)
  const callerCopy = callerKey.slice()
  const nonce = raw(fixture.publicEncoding.nonce)
  try {
    crypto.subtle.encrypt = async () => { throw new DOMException('ENCRYPT_MARKER') }
    assert.equal(await errorText(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: callerKey, keyring: standardRing, nonceFactory: () => nonce })), 'Error:BACKUP_CRYPTO_FAILED')
  } finally {
    crypto.subtle.encrypt = originalEncrypt
  }
  assert.deepEqual([...callerKey], [...callerCopy])
  assert.deepEqual([...nonce], Array(12).fill(0))
  const wrongKeyRing = await keyring({ versions: { 1: 202 } })
  assert.equal(await errorText(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: wrongKeyRing })), 'Error:BACKUP_MANIFEST_INVALID')
  const originalDecrypt = crypto.subtle.decrypt
  try {
    crypto.subtle.decrypt = async () => new Uint8Array(31).buffer
    assert.equal(await errorText(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: standardRing })), 'Error:BACKUP_MANIFEST_INVALID')
  } finally {
    crypto.subtle.decrypt = originalDecrypt
  }
})

test('opening authenticates every mutable fact and the smallest valid coupled fact groups', async () => {
  const standardRing = await keyring()
  const mutations = [
    (m) => { m.createdAt = '2026-08-03T12:34:57.789Z' },
    (m) => { m.localDay = '2026-08-04' },
    (m) => { m.retentionClass = 'monthly' },
    (m) => { m.objectEtag = 'public-etag-v2' },
    (m) => { m.objectSize = 12346 },
    (m) => { m.atBookmark = 'public-bookmark-v2' },
    (m) => { m.backupId = 'bkp_gate2_other'; m.objectKey = 'backups/v1/2026/08/bkp_gate2_other.sql' },
    (m) => { m.localDay = '2026-09-01'; m.localMonth = '2026-09'; m.objectKey = 'backups/v1/2026/09/bkp_gate1_202608.sql' },
  ]
  for (const mutate of mutations) await manifestInvalid(() => openBackupManifest({ bytes: manifestBytes(mutate), keyring: standardRing }))
  await manifestInvalid(() => openBackupManifest({ bytes: manifestBytes((m) => { m.format = 'bwm-d1-sql-v2' }), keyring: standardRing }))
  await manifestInvalid(() => openBackupManifest({ bytes: manifestBytes((m) => { m.objectKey = 'backups/v1/2026/08/bkp_other.sql' }), keyring: standardRing }))
})

test('opening authenticates declared version, nonce, and ciphertext without fallback', async () => {
  const calls = []
  const one = await importKek(fixture.publicDerivationSeeds.backupKek)
  const two = await importKek(202)
  const ring = { activeBackupKekVersion: 1, backupKekVersions: [2, 1], getBackupKek(version) { calls.push(version); return version === 2 ? two : one } }
  await manifestInvalid(() => openBackupManifest({ bytes: manifestBytes((m) => { m.wrappedSsecKey.kekVersion = 2 }), keyring: ring }))
  assert.deepEqual(calls, [2])
  const nonce = raw(fixture.publicEncoding.nonce); nonce[0] ^= 1
  await manifestInvalid(() => openBackupManifest({ bytes: manifestBytes((m) => { m.wrappedSsecKey.nonce = encode(nonce) }), keyring: ring }))
  const ciphertext = raw(fixture.publicEncoding.ciphertext); ciphertext[0] ^= 1
  await manifestInvalid(() => openBackupManifest({ bytes: manifestBytes((m) => { m.wrappedSsecKey.ciphertext = encode(ciphertext) }), keyring: ring }))
})

test('fixture AAD independently reproduces the public ciphertext vector', async () => {
  const key = await importKek(fixture.publicDerivationSeeds.backupKek)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: raw(fixture.publicEncoding.nonce), additionalData: bytes(fixture.aadText), tagLength: 128,
  }, key, derive(fixture.publicDerivationSeeds.rawSsecKey)))
  assert.equal(encode(encrypted), fixture.publicEncoding.ciphertext)
  assert.equal(fixture.aadText, `bwm:backup-key:v1\n${canonical(fixture.facts)}`)
})

test('fixture and public outputs exclude raw key representations and private-data markers', async () => {
  const result = await createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(fixture.publicDerivationSeeds.rawSsecKey), keyring: await keyring(), nonceFactory: () => raw(fixture.publicEncoding.nonce) })
  const wrongRing = await keyring({ versions: { 1: 202 } })
  const errors = [
    await errorText(() => createBackupManifest({ ...result, extra: true })),
    await errorText(() => openBackupManifest({ bytes: result.bytes, keyring: wrongRing })),
  ]
  const fixtureText = readFileSync(new URL('../fixtures/backup-format-v1.json', import.meta.url), 'utf8')
  const publicText = [fixtureText, JSON.stringify(result.manifest), new TextDecoder().decode(result.bytes), JSON.stringify(result.databaseFields), JSON.stringify(expectedObjectMetadata(result.manifest)), JSON.stringify(errors)].join('\n')
  const secretForms = Object.values(fixture.publicDerivationSeeds).flatMap((seed) => {
    const secret = derive(seed)
    return [encode(secret), Buffer.from(secret).toString('hex'), [...secret].join(','), JSON.stringify([...secret]), String.fromCharCode(...secret)]
  })
  for (const representation of secretForms) assert.equal(publicText.includes(representation), false)
  for (const marker of ['CREATE TABLE private_record', 'https://private.example', 'credential=secret', '/Users/private/record', 'private@example.com', '+48 600 000 000', 'Jan Kowalski']) {
    assert.equal(publicText.includes(marker), false)
  }
  for (const pattern of [/\b(?:CREATE|INSERT|SELECT|UPDATE|DELETE)\s+/i, /https?:\/\//i, /\b(?:password|credential|api[_-]?key)\b/i, /(?:\/Users\/|[A-Z]:\\)/, /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/, /\+\d[\d ()-]{8,}\d/]) {
    assert.equal(pattern.test(publicText), false)
  }
  assert.deepEqual(errors, ['Error:BACKUP_CRYPTO_FAILED', 'Error:BACKUP_MANIFEST_INVALID'])
})
