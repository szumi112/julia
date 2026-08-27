import { describe, expect, it, vi } from 'vitest'
import fixture from '../fixtures/backup-format-v1.json'
import fixtureV2 from '../fixtures/backup-format-v2.json'
import {
  backupObjectKeys, canonicalJson, createBackupManifest, expectedObjectMetadata, openBackupManifest, parseCanonicalManifest,
} from '../../worker/operations/backup-format.js'
import * as backupFormat from '../../worker/operations/backup-format.js'

const invalid = (operation) => expect(operation).toThrow(/^BACKUP_MANIFEST_INVALID$/)
const bytes = (value) => new TextEncoder().encode(value)
const raw = (value) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0))
const valid = () => structuredClone(fixture.manifest)
const derive = (seed) => Uint8Array.from({ length: 32 }, (_, index) => (seed + (index * 29)) & 0xff)
const importKek = (seed) => crypto.subtle.importKey('raw', derive(seed), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
const importAes = (seed, { length = 256, extractable = false, usages = ['encrypt', 'decrypt'] } = {}) => crypto.subtle.importKey(
  'raw', derive(seed).subarray(0, length / 8), { name: 'AES-GCM', length }, extractable, usages,
)
const encode = (value) => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const manifestBytes = (mutate) => {
  const manifest = valid()
  mutate(manifest)
  return bytes(canonicalJson(manifest))
}
const errorText = async (operation) => {
  try {
    await operation()
    throw new Error('expected rejection')
  } catch (error) {
    return `${error?.name}:${error?.message}`
  }
}
const cryptoFailed = async (operation) => await expect(operation()).rejects.toThrow(/^BACKUP_CRYPTO_FAILED$/)
const manifestInvalid = async (operation) => await expect(operation()).rejects.toThrow(/^BACKUP_MANIFEST_INVALID$/)
const keyring = async ({ active = 1, versions = { 1: fixture.publicDerivationSeeds.backupKek } } = {}) => Object.freeze({
  activeBackupKekVersion: active,
  backupKekVersions: Object.freeze(Object.keys(versions).map(Number)),
  getBackupKek: async (version) => versions[version] === undefined ? null : await importKek(versions[version]),
})

describe('backup format under workerd', () => {
  it('serializes the shared public fixture canonically', () => {
    for (const entry of fixture.canonicalCases) expect(canonicalJson(entry.value)).toBe(entry.json)
    expect(canonicalJson(fixture.manifest)).toBe(fixture.canonicalManifestJson)
  })

  it('rejects hostile canonical inputs without executing an accessor or proxy trap', () => {
    let accessed = false
    const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get() { accessed = true; return 1 } })
    const proxy = new Proxy({}, { ownKeys() { throw new Error('marker') } })
    const sparse = []; sparse[1] = 1
    const cyclic = {}; cyclic.self = cyclic
    const nonEnumerable = { value: 1 }; Object.defineProperty(nonEnumerable, 'hidden', { value: 2 })
    const extraArray = [1]; extraArray.extra = true
    for (const value of [undefined, Symbol('x'), 1n, () => {}, new String('x'), Infinity, -Infinity, NaN, new Date(), accessor, proxy, sparse, cyclic, extraArray, nonEnumerable, { [Symbol('x')]: 1 }, Object.create(null), Object.create({ value: 1 }), new Uint8Array(1), { constructor: 1 }]) invalid(() => canonicalJson(value))
    expect(accessed).toBe(false)
  })

  it('uses one audited proxy key and descriptor snapshot', () => {
    let keyReads = 0
    const changingKeys = new Proxy({ value: 1 }, {
      ownKeys(target) { return ++keyReads === 1 ? Reflect.ownKeys(target) : [] },
    })
    expect(canonicalJson(changingKeys)).toBe('{"value":1}')
    let lengthReads = 0
    const changingLength = new Proxy([1], {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'length' && ++lengthReads > 1) throw new Error('marker')
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    expect(canonicalJson(changingLength)).toBe('[1]')
  })

  it('derives exact object keys and rejects malformed exact inputs', () => {
    expect(backupObjectKeys({ backupId: fixture.manifest.backupId, localMonth: fixture.manifest.localMonth })).toEqual(fixture.objectKeys)
    expect(backupObjectKeys({ backupId: `bkp_${'a'.repeat(124)}`, localMonth: '2000-02' })).toEqual({ objectKey: `backups/v1/2000/02/bkp_${'a'.repeat(124)}.sql`, manifestKey: `backups/v1/2000/02/bkp_${'a'.repeat(124)}.manifest.json` })
    const accessor = {}; Object.defineProperty(accessor, 'backupId', { enumerable: true, get() { throw new Error('marker') } }); accessor.localMonth = '2026-02'
    for (const value of [null, {}, accessor, { backupId: 'bkp_x', localMonth: '2026-13' }, { backupId: 'bkp_x', localMonth: '2026-02', extra: true }, { backupId: 'bkp_x', localMonth: '2026-02', [Symbol('x')]: 1 }, Object.create({ backupId: 'bkp_x', localMonth: '2026-02' }), { backupId: 'bkp_x', localMonth: '2026-2' }, { backupId: 'no', localMonth: '2026-02' }, { backupId: `bkp_${'a'.repeat(125)}`, localMonth: '2026-02' }]) invalid(() => backupObjectKeys(value))
  })

  it('parses only the exact shared bytes and calls JSON.parse once', () => {
    const spy = vi.spyOn(JSON, 'parse')
    expect(parseCanonicalManifest(raw(fixture.canonicalManifestBase64Url))).toEqual(fixture.manifest)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('rejects byte, JSON, schema, opaque-field, and canonical-form variants', () => {
    for (const value of Object.values(fixture.invalidRawBytes)) invalid(() => parseCanonicalManifest(raw(value)))
    for (const input of [new ArrayBuffer(1), new DataView(new ArrayBuffer(1)), new Uint16Array(1), 'text']) invalid(() => parseCanonicalManifest(input))
    invalid(() => parseCanonicalManifest(bytes('{')))
    for (const mutate of [
      (m) => { m.format = 'wrong' }, (m) => { m.createdAt = '2026-08-03T12:34:56Z' },
      (m) => { m.localDay = '2026-02-30' }, (m) => { m.localMonth = '2026-07' },
      (m) => { m.objectKey = 'wrong' }, (m) => { m.objectEtag = '' },
      (m) => { m.atBookmark = fixture.opaqueBoundaries.tooLong }, (m) => { m.objectSize = -1 },
      (m) => { m.wrappedSsecKey = { ...m.wrappedSsecKey, algorithm: 'A128GCM' } },
      (m) => { m.wrappedSsecKey = { ...m.wrappedSsecKey, kekVersion: 0 } },
      (m) => { m.wrappedSsecKey = { ...m.wrappedSsecKey, nonce: 'AAECAwQFBgcICQo' } },
      (m) => { m.wrappedSsecKey = { ...m.wrappedSsecKey, ciphertext: 'AA' } },
    ]) { const manifest = valid(); mutate(manifest); invalid(() => parseCanonicalManifest(bytes(canonicalJson(manifest)))) }
  })

  it('keeps every raw canonical-form variant as a complete manifest before byte rejection', () => {
    for (const name of ['whitespace', 'newline', 'rootDuplicate', 'nestedDuplicate', 'reorderedRoot', 'nestedReordered', 'alternateNumber', 'textualEscape']) {
      expect(JSON.parse(new TextDecoder().decode(raw(fixture.invalidRawBytes[name])))).toEqual(fixture.manifest)
    }
    const bom = raw(fixture.invalidRawBytes.bom)
    expect(JSON.parse(new TextDecoder().decode(bom.subarray(3)))).toEqual(fixture.manifest)
    const malformed = JSON.parse(new TextDecoder().decode(raw(fixture.invalidRawBytes.malformedUtf8)))
    expect(malformed.objectKey).toBe(fixture.manifest.objectKey)
    expect(malformed.objectEtag).toContain('\uFFFD')
  })

  it('rejects every missing and wrong root or wrapped-key field under workerd', () => {
    const wrongRoot = {
      format: 1, backupId: 'wrong', createdAt: 'wrong', localDay: 'wrong', localMonth: 'wrong',
      retentionClass: 'wrong', objectKey: 'wrong', objectEtag: 1, objectSize: '1', atBookmark: 1, wrappedSsecKey: 1,
    }
    const wrongWrapped = { algorithm: 'wrong', kekVersion: '1', nonce: 'wrong', ciphertext: 'wrong' }
    for (const field of Object.keys(valid())) {
      const manifest = valid(); delete manifest[field]
      invalid(() => parseCanonicalManifest(bytes(canonicalJson(manifest))))
    }
    for (const [field, value] of Object.entries(wrongRoot)) {
      const manifest = valid(); manifest[field] = value
      invalid(() => parseCanonicalManifest(bytes(canonicalJson(manifest))))
    }
    for (const mutate of [
      (m) => { m.unknown = true },
      (m) => { m.wrappedSsecKey.unknown = true },
    ]) { const manifest = valid(); mutate(manifest); invalid(() => parseCanonicalManifest(bytes(canonicalJson(manifest)))) }
    for (const field of Object.keys(valid().wrappedSsecKey)) {
      const manifest = valid(); delete manifest.wrappedSsecKey[field]
      invalid(() => parseCanonicalManifest(bytes(canonicalJson(manifest))))
    }
    for (const [field, value] of Object.entries(wrongWrapped)) {
      const manifest = valid(); manifest.wrappedSsecKey[field] = value
      invalid(() => parseCanonicalManifest(bytes(canonicalJson(manifest))))
    }
  })

  it('enforces relationships, opaque UTF-8 limits, and canonical base64url under workerd', () => {
    for (const mutate of [
      (m) => { m.createdAt = '2026-08-03T12:34:56Z' }, (m) => { m.createdAt = '2026-02-30T12:34:56.789Z' }, (m) => { m.localDay = '2026-02-30' },
      (m) => { m.localMonth = '2026-07' }, (m) => { m.objectKey = 'wrong' },
      (m) => { m.objectSize = 1.5 }, (m) => { m.objectSize = Number.MAX_SAFE_INTEGER + 1 }, (m) => { m.wrappedSsecKey.kekVersion = 0 }, (m) => { m.wrappedSsecKey.kekVersion = 1.5 },
      (m) => { m.wrappedSsecKey.nonce = 'AAECAwQFBgcICQo' }, (m) => { m.wrappedSsecKey.nonce = `${fixture.publicEncoding.nonce}=` }, (m) => { m.wrappedSsecKey.ciphertext = 'AA' },
      (m) => { m.wrappedSsecKey.ciphertext = `${fixture.publicEncoding.ciphertext}=` }, (m) => { m.wrappedSsecKey.ciphertext = fixture.publicEncoding.ciphertext.replace(/.$/, '+') },
    ]) { const manifest = valid(); mutate(manifest); invalid(() => parseCanonicalManifest(bytes(canonicalJson(manifest)))) }
    expect(new TextEncoder().encode(fixture.opaqueBoundaries.multiByteMax).byteLength).toBe(1024)
    expect(new TextEncoder().encode(fixture.opaqueBoundaries.multiByteTooLong).byteLength).toBe(1025)
    for (const field of ['objectEtag', 'atBookmark']) for (const value of ['', fixture.opaqueBoundaries.tooLong, fixture.opaqueBoundaries.multiByteTooLong, ' bad', 'bad ', 'bad\nvalue', 'bad\u200Evalue', 'e\u0301']) {
      const manifest = valid(); manifest[field] = value
      invalid(() => parseCanonicalManifest(bytes(canonicalJson(manifest))))
    }
    for (const value of [fixture.opaqueBoundaries.one, fixture.opaqueBoundaries.max, fixture.opaqueBoundaries.multiByteMax]) {
      const manifest = valid(); manifest.objectEtag = value; manifest.atBookmark = value
      expect(parseCanonicalManifest(bytes(canonicalJson(manifest)))).toEqual(manifest)
    }
  })

  it('returns exact metadata and rejects partial or lookalike manifests', () => {
    expect(expectedObjectMetadata(valid())).toEqual(fixture.metadata)
    const partial = valid(); delete partial.objectKey
    invalid(() => expectedObjectMetadata(partial))
    invalid(() => expectedObjectMetadata({ ...fixture.metadata, objectKey: fixture.manifest.objectKey }))
  })

  it('has the exact crypto namespace and deterministic authenticated vector', async () => {
    expect(Object.keys(backupFormat).sort()).toEqual([
      'backupObjectKeys', 'canonicalJson', 'createBackupManifest', 'expectedObjectMetadata', 'openBackupManifest', 'parseCanonicalManifest',
    ])
    const callerKey = derive(fixture.publicDerivationSeeds.rawSsecKey)
    const original = callerKey.slice()
    const nonce = raw(fixture.publicEncoding.nonce)
    const result = await createBackupManifest({ facts: structuredClone(fixture.facts), rawSsecKey: callerKey, keyring: await keyring(), nonceFactory: () => nonce })
    expect(Reflect.ownKeys(result).sort()).toEqual(['bytes', 'databaseFields', 'manifest'])
    expect(result.manifest).toEqual(fixture.manifest)
    expect(new TextDecoder().decode(result.bytes)).toBe(fixture.canonicalManifestJson)
    expect([...result.bytes]).toEqual([...raw(fixture.canonicalManifestBase64Url)])
    expect(result.databaseFields).toEqual(fixture.databaseFields)
    expect([...callerKey]).toEqual([...original])
    expect([...nonce]).toEqual(Array(12).fill(0))
  })

  it('opens with only the declared KEK and closes async crypto failures', async () => {
    const used = []
    const one = await importKek(fixture.publicDerivationSeeds.backupKek)
    const ring = Object.freeze({ activeBackupKekVersion: 1, backupKekVersions: Object.freeze([2, 1]), getBackupKek(version) { used.push(version); return version === 1 ? one : null } })
    const opened = await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ring })
    const second = await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ring })
    expect(Reflect.ownKeys(opened).sort()).toEqual(['manifest', 'rawSsecKey'])
    expect(opened.manifest).toEqual(fixture.manifest)
    expect(opened.rawSsecKey).toBeInstanceOf(Uint8Array)
    expect(opened.rawSsecKey.byteLength).toBe(32)
    expect([...opened.rawSsecKey]).toEqual([...derive(fixture.publicDerivationSeeds.rawSsecKey)])
    expect(opened.rawSsecKey).not.toBe(second.rawSsecKey)
    const first = opened.rawSsecKey[0]
    opened.rawSsecKey[0] ^= 0xff
    expect(opened.rawSsecKey[0]).not.toBe(first)
    expect(second.rawSsecKey[0]).toBe(derive(fixture.publicDerivationSeeds.rawSsecKey)[0])
    expect(used).toEqual([1, 1])
    await cryptoFailed(() => createBackupManifest({ facts: { ...fixture.facts, extra: true }, rawSsecKey: derive(1), keyring: ring, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(1), keyring: ring, nonceFactory: () => new Uint8Array(11) }))
    const missing = await keyring({ versions: {} })
    await manifestInvalid(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: missing }))
    const tampered = structuredClone(fixture.manifest); tampered.wrappedSsecKey.ciphertext = fixture.publicEncoding.ciphertext.replace(/^./, 'A')
    await manifestInvalid(() => openBackupManifest({ bytes: bytes(canonicalJson(tampered)), keyring: ring }))
  })

  it('zeroes retained internal encryption buffers while preserving the caller key', async () => {
    const callerKey = derive(73)
    const callerCopy = callerKey.slice()
    const transferredNonce = raw(fixture.publicEncoding.nonce)
    const encryptedResult = new Uint8Array(48); encryptedResult.fill(91)
    let captured
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (algorithm, _key, plaintext) => {
      captured = { iv: algorithm.iv, aad: algorithm.additionalData, plaintext }
      return encryptedResult.buffer
    })
    try {
      const result = await createBackupManifest({ facts: fixture.facts, rawSsecKey: callerKey, keyring: await keyring(), nonceFactory: () => transferredNonce })
      expect(Reflect.ownKeys(result).sort()).toEqual(['bytes', 'databaseFields', 'manifest'])
    } finally {
      encryptSpy.mockRestore()
    }
    expect([...callerKey]).toEqual([...callerCopy])
    for (const value of [transferredNonce, captured.iv, captured.aad, captured.plaintext, encryptedResult]) {
      expect([...value]).toEqual(Array(value.byteLength).fill(0))
    }
  })

  it('zeroes retained decoded buffers but transfers successful plaintext ownership', async () => {
    const standardRing = await keyring()
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    let captured
    let opened
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation((algorithm, key, ciphertext) => {
      captured = { iv: algorithm.iv, aad: algorithm.additionalData, ciphertext }
      return originalDecrypt(algorithm, key, ciphertext)
    })
    try {
      opened = await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: standardRing })
    } finally {
      decryptSpy.mockRestore()
    }
    for (const value of [captured.iv, captured.aad, captured.ciphertext]) {
      expect([...value]).toEqual(Array(value.byteLength).fill(0))
    }
    expect(opened.rawSsecKey).toBeInstanceOf(Uint8Array)
    expect(opened.rawSsecKey.byteLength).toBe(32)
    expect(opened.rawSsecKey.some((value) => value !== 0)).toBe(true)
    const first = opened.rawSsecKey[0]
    opened.rawSsecKey[0] ^= 0xff
    expect(opened.rawSsecKey[0]).not.toBe(first)

    const shortPlaintext = new Uint8Array(31); shortPlaintext.fill(57)
    const shortSpy = vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValue(shortPlaintext.buffer)
    try {
      await manifestInvalid(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: standardRing }))
    } finally {
      shortSpy.mockRestore()
    }
    expect([...shortPlaintext]).toEqual(Array(31).fill(0))
  })

  it('rejects non-production AES key shapes before Web Crypto', async () => {
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
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt')
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt')
    for (const key of keys) {
      const ring = { activeBackupKekVersion: 1, getBackupKek: () => key }
      await cryptoFailed(() => createBackupManifest({ facts: structuredClone(fixture.facts), rawSsecKey: derive(3), keyring: ring, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
      await manifestInvalid(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ring }))
    }
    expect(encryptSpy).not.toHaveBeenCalled()
    expect(decryptSpy).not.toHaveBeenCalled()
    encryptSpy.mockRestore()
    decryptSpy.mockRestore()
    const reversed = await importAes(fixture.publicDerivationSeeds.backupKek, { usages: ['decrypt', 'encrypt'] })
    const ring = { activeBackupKekVersion: 1, getBackupKek: () => reversed }
    expect((await createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(fixture.publicDerivationSeeds.rawSsecKey), keyring: ring, nonceFactory: () => raw(fixture.publicEncoding.nonce) })).manifest).toEqual(fixture.manifest)
    expect((await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ring })).manifest).toEqual(fixture.manifest)
  })

  it('rejects every inexact outer object without invoking accessors or traps', async () => {
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
    for (const input of [null, { ...createBase, extra: true }, { ...createBase, [Symbol('outer')]: true }, Object.create(createBase), createAccessor, new Proxy(createBase, { ownKeys() { throw new Error('OUTER_PROXY') } })]) {
      await cryptoFailed(() => createBackupManifest(input))
    }
    for (const input of [null, { ...openBase, extra: true }, { ...openBase, [Symbol('outer')]: true }, Object.create(openBase), openAccessor, new Proxy(openBase, { ownKeys() { throw new Error('OUTER_PROXY') } })]) {
      await manifestInvalid(() => openBackupManifest(input))
    }
    expect(invoked).toBe(false)
  })

  it('audits exact facts before nonce creation or key lookup', async () => {
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
    expect(invoked).toBe(false)
    expect(nonceCalls).toBe(0)
    expect(keyCalls).toBe(0)
  })

  it('audits keyring descriptors and closes throwing or rejected lookup calls', async () => {
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
    expect(invoked).toBe(false)
    const ignoresActive = { activeBackupKekVersion: 0, backupKekVersions: 'ignored', getBackupKek: () => goodKey }
    expect((await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ignoresActive })).manifest).toEqual(fixture.manifest)
  })

  it('uses active version once for creation and only a different declared version for opening', async () => {
    const calls = []
    const one = await importKek(fixture.publicDerivationSeeds.backupKek)
    const two = await importKek(151)
    const ring = { activeBackupKekVersion: 2, backupKekVersions: [2, 1], getBackupKek(version) { calls.push(version); return version === 1 ? one : two } }
    const created = await createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: ring, nonceFactory: () => raw(fixture.publicEncoding.nonce) })
    expect(created.manifest.wrappedSsecKey.kekVersion).toBe(2)
    expect(calls).toEqual([2])
    calls.length = 0
    await openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: ring })
    expect(calls).toEqual([1])
    calls.length = 0
    const noFallback = { activeBackupKekVersion: 2, backupKekVersions: [2], getBackupKek(version) { calls.push(version); return null } }
    await manifestInvalid(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: noFallback }))
    expect(calls).toEqual([1])
  })

  it('rejects raw-key and nonce variants while preserving caller bytes and zeroing transferred nonces', async () => {
    const standardRing = await keyring()
    const detached = new Uint8Array(32)
    structuredClone(detached.buffer, { transfer: [detached.buffer] })
    for (const rawSsecKey of [null, new ArrayBuffer(32), new DataView(new ArrayBuffer(32)), new Uint16Array(16), new Uint8Array(31), new Uint8Array(33), detached]) {
      await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey, keyring: standardRing, nonceFactory: () => raw(fixture.publicEncoding.nonce) }))
    }
    for (const returned of [new Uint8Array(0), new Uint8Array(11), new Uint8Array(13)]) {
      returned.fill(9)
      await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory: () => returned }))
      expect([...returned]).toEqual(Array(returned.length).fill(0))
    }
    for (const returned of [null, new ArrayBuffer(12), new Uint16Array(6), 'nonce']) {
      await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory: () => returned }))
    }
    let calls = 0
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory(...args) { calls += 1; expect(args).toHaveLength(0); throw new Error('NONCE_THROW') } }))
    expect(calls).toBe(1)
    const callerKey = derive(77)
    const original = callerKey.slice()
    const nonce = raw(fixture.publicEncoding.nonce)
    const rejectingRing = { activeBackupKekVersion: 1, getBackupKek: async () => { throw new Error('AFTER_COPY') } }
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: callerKey, keyring: rejectingRing, nonceFactory: () => nonce }))
    expect([...callerKey]).toEqual([...original])
    expect([...nonce]).toEqual(Array(12).fill(0))
  })

  it('observes invalid nonce promises and zeroes a resolved Uint8Array', async () => {
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
    expect(prompt).toBe('BACKUP_CRYPTO_FAILED')
    const resolvedNonce = new Uint8Array(12); resolvedNonce.fill(43)
    let resolveNonce
    const resolving = new Promise((resolve) => { resolveNonce = resolve })
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory: () => resolving }))
    resolveNonce(resolvedNonce)
    await Promise.resolve()
    expect([...resolvedNonce]).toEqual(Array(12).fill(0))
    let rejectNonce
    const rejecting = new Promise((_resolve, reject) => { rejectNonce = reject })
    await cryptoFailed(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(3), keyring: standardRing, nonceFactory: () => rejecting }))
    rejectNonce(new Error('ASYNC_NONCE_MARKER'))
    await Promise.resolve()
    await Promise.resolve()
  })

  it('closes async Web Crypto failures and wrong decrypted plaintext lengths', async () => {
    const standardRing = await keyring()
    const callerKey = derive(88)
    const callerCopy = callerKey.slice()
    const nonce = raw(fixture.publicEncoding.nonce)
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValue(new DOMException('ENCRYPT_MARKER'))
    expect(await errorText(() => createBackupManifest({ facts: fixture.facts, rawSsecKey: callerKey, keyring: standardRing, nonceFactory: () => nonce }))).toBe('Error:BACKUP_CRYPTO_FAILED')
    encryptSpy.mockRestore()
    expect([...callerKey]).toEqual([...callerCopy])
    expect([...nonce]).toEqual(Array(12).fill(0))
    const wrongKeyRing = await keyring({ versions: { 1: 202 } })
    expect(await errorText(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: wrongKeyRing }))).toBe('Error:BACKUP_MANIFEST_INVALID')
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValue(new Uint8Array(31).buffer)
    expect(await errorText(() => openBackupManifest({ bytes: raw(fixture.canonicalManifestBase64Url), keyring: standardRing }))).toBe('Error:BACKUP_MANIFEST_INVALID')
    decryptSpy.mockRestore()
  })

  it('authenticates every mutable fact and the smallest valid coupled fact groups', async () => {
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

  it('authenticates declared version, nonce, and ciphertext without fallback', async () => {
    const calls = []
    const one = await importKek(fixture.publicDerivationSeeds.backupKek)
    const two = await importKek(202)
    const ring = { activeBackupKekVersion: 1, backupKekVersions: [2, 1], getBackupKek(version) { calls.push(version); return version === 2 ? two : one } }
    await manifestInvalid(() => openBackupManifest({ bytes: manifestBytes((m) => { m.wrappedSsecKey.kekVersion = 2 }), keyring: ring }))
    expect(calls).toEqual([2])
    const nonce = raw(fixture.publicEncoding.nonce); nonce[0] ^= 1
    await manifestInvalid(() => openBackupManifest({ bytes: manifestBytes((m) => { m.wrappedSsecKey.nonce = encode(nonce) }), keyring: ring }))
    const ciphertext = raw(fixture.publicEncoding.ciphertext); ciphertext[0] ^= 1
    await manifestInvalid(() => openBackupManifest({ bytes: manifestBytes((m) => { m.wrappedSsecKey.ciphertext = encode(ciphertext) }), keyring: ring }))
  })

  it('independently reproduces the fixture ciphertext from its exact AAD', async () => {
    const key = await importKek(fixture.publicDerivationSeeds.backupKek)
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM', iv: raw(fixture.publicEncoding.nonce), additionalData: bytes(fixture.aadText), tagLength: 128,
    }, key, derive(fixture.publicDerivationSeeds.rawSsecKey)))
    expect(encode(encrypted)).toBe(fixture.publicEncoding.ciphertext)
    expect(fixture.aadText).toBe(`bwm:backup-key:v1\n${canonicalJson(fixture.facts)}`)
  })

  it('excludes raw key representations and private-data markers from fixture and public outputs', async () => {
    const result = await createBackupManifest({ facts: fixture.facts, rawSsecKey: derive(fixture.publicDerivationSeeds.rawSsecKey), keyring: await keyring(), nonceFactory: () => raw(fixture.publicEncoding.nonce) })
    const wrongRing = await keyring({ versions: { 1: 202 } })
    const errors = [
      await errorText(() => createBackupManifest({ ...result, extra: true })),
      await errorText(() => openBackupManifest({ bytes: result.bytes, keyring: wrongRing })),
    ]
    const publicText = [JSON.stringify(fixture), JSON.stringify(result.manifest), new TextDecoder().decode(result.bytes), JSON.stringify(result.databaseFields), JSON.stringify(expectedObjectMetadata(result.manifest)), JSON.stringify(errors)].join('\n')
    const secretForms = Object.values(fixture.publicDerivationSeeds).flatMap((seed) => {
      const secret = derive(seed)
      return [encode(secret), [...secret].map((value) => value.toString(16).padStart(2, '0')).join(''), [...secret].join(','), JSON.stringify([...secret]), String.fromCharCode(...secret)]
    })
    for (const representation of secretForms) expect(publicText.includes(representation)).toBe(false)
    for (const marker of ['CREATE TABLE private_record', 'https://private.example', 'credential=secret', '/Users/private/record', 'private@example.com', '+48 600 000 000', 'Jan Kowalski']) {
      expect(publicText.includes(marker)).toBe(false)
    }
    for (const pattern of [/\b(?:CREATE|INSERT|SELECT|UPDATE|DELETE)\s+/i, /https?:\/\//i, /\b(?:password|credential|api[_-]?key)\b/i, /(?:\/Users\/|[A-Z]:\\)/, /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/, /\+\d[\d ()-]{8,}\d/]) {
      expect(pattern.test(publicText)).toBe(false)
    }
    expect(errors).toEqual(['Error:BACKUP_CRYPTO_FAILED', 'Error:BACKUP_MANIFEST_INVALID'])
  })
})

describe('backup manifest v2 under workerd', () => {
  it('reproduces and opens the shared authenticated source/migrations/sentinel vector', async () => {
    expect(backupObjectKeys({
      backupId: fixtureV2.manifest.backupId,
      localMonth: fixtureV2.manifest.localMonth,
      version: 2,
    })).toEqual(fixtureV2.objectKeys)
    expect(parseCanonicalManifest(raw(fixtureV2.canonicalManifestBase64Url))).toEqual(fixtureV2.manifest)
    expect(expectedObjectMetadata(fixtureV2.manifest)).toEqual(fixtureV2.metadata)
    const ring = await keyring()
    const result = await createBackupManifest({
      facts: structuredClone(fixtureV2.facts),
      rawSsecKey: derive(fixtureV2.publicDerivationSeeds.rawSsecKey),
      keyring: ring,
      nonceFactory: () => raw(fixtureV2.publicEncoding.nonce),
    })
    expect(result.manifest).toEqual(fixtureV2.manifest)
    expect(new TextDecoder().decode(result.bytes)).toBe(fixtureV2.canonicalManifestJson)
    const opened = await openBackupManifest({ bytes: result.bytes, keyring: ring })
    expect(opened.manifest).toEqual(fixtureV2.manifest)
    expect([...opened.rawSsecKey]).toEqual([...derive(fixtureV2.publicDerivationSeeds.rawSsecKey)])
  })

  it('rejects migration drift and sentinel/source tampering before decryption succeeds', async () => {
    const ring = await keyring()
    for (const mutate of [
      (m) => { m.appliedMigrations.reverse() },
      (m) => { m.appliedMigrations[1].name = '0002_tampered.sql' },
      (m) => { m.restoreSentinel.backupId = 'bkp_other' },
      (m) => { m.source.appEnv = 'production' },
    ]) {
      const manifest = structuredClone(fixtureV2.manifest)
      mutate(manifest)
      await manifestInvalid(() => openBackupManifest({ bytes: bytes(canonicalJson(manifest)), keyring: ring }))
    }
  })
})
