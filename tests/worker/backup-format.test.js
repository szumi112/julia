import { describe, expect, it, vi } from 'vitest'
import fixture from '../fixtures/backup-format-v1.json'
import {
  backupObjectKeys, canonicalJson, expectedObjectMetadata, parseCanonicalManifest,
} from '../../worker/operations/backup-format.js'

const invalid = (operation) => expect(operation).toThrow(/^BACKUP_MANIFEST_INVALID$/)
const bytes = (value) => new TextEncoder().encode(value)
const raw = (value) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0))
const valid = () => structuredClone(fixture.manifest)

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
})
