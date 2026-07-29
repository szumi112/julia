import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { decodeBase64Url, encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  blindEmailCandidates,
  blindEmailIndex,
  createWrappedDataKey,
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
  loadDataKey,
  rewrapDataKey,
} from '../../worker/security/envelope.js'

const secret = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const config = { activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1 }
const scope = { type: 'staff_directory', id: 'centre_1', purpose: 'identity' }
const now = '2026-07-29T10:00:00.000Z'
const rowKeys = ['created_at', 'dek_version', 'id', 'kek_version', 'purpose', 'retired_at', 'scope_id', 'scope_type', 'wrap_nonce_b64', 'wrapped_key_b64']
const envelopeKeys = ['algorithm', 'ciphertext', 'dataKeyId', 'dataKeyVersion', 'format', 'nonce']
const rowScope = (row) => ({ type: row.scope_type, id: row.scope_id, purpose: row.purpose })

const keyring = (overrides = {}, settings = config) => createKeyring({
  BWM_DATA_KEK_V1: secret(1),
  BWM_LOOKUP_HMAC_V1: secret(2),
  BWM_BACKUP_KEK_V1: secret(3),
  ...overrides,
}, settings)

const flip = (value) => {
  const bytes = decodeBase64Url(value)
  bytes[Math.floor(bytes.length / 2)] ^= 1
  return encodeBase64Url(bytes)
}

const cryptoFailure = (operation) => expect(operation).rejects.toThrow(/^CRYPTO_FAILURE$/)

describe('canonical base64url encoding', () => {
  it('encodes known bytes and respects typed-array byte ranges', () => {
    expect(encodeBase64Url(new Uint8Array([0, 1, 2, 253, 254, 255]))).toBe('AAEC_f7_')
    const source = new Uint8Array([9, 0, 1, 2, 8])
    expect(encodeBase64Url(source.subarray(1, 4))).toBe('AAEC')
    expect(decodeBase64Url('')).toEqual(new Uint8Array())
    expect(decodeBase64Url('AAEC')).toEqual(new Uint8Array([0, 1, 2]))
  })

  it('encodes ArrayBuffers and every selected ArrayBufferView byte range', () => {
    expect(encodeBase64Url(new Uint8Array([0, 1, 2]).buffer)).toBe('AAEC')
    const source = new Uint8Array([9, 0, 1, 2, 8]).buffer
    expect(encodeBase64Url(new DataView(source, 1, 3))).toBe('AAEC')
    expect(encodeBase64Url(new Int8Array(source, 1, 3))).toBe('AAEC')
    const words = new Uint16Array([0x0100, 0x0302, 0x0504])
    expect(encodeBase64Url(new Uint16Array(words.buffer, 2, 1))).toBe('AgM')
    expect(() => encodeBase64Url('AAEC')).toThrow(/^INVALID_BASE64URL$/)
  })

  it.each(['A', 'AA=', 'AA ', ' AA', 'AA\n', 'AA+', 'AA/', 'AA*', 'AĀ', 'AB', 'AAB'])('rejects non-canonical form %j', (value) => {
    expect(() => decodeBase64Url(value)).toThrow(/^INVALID_BASE64URL$/)
  })
})

describe('keyring', () => {
  it('imports retained keys as nonextractable minimal-usage keys with an active version below newest', async () => {
    const ring = await keyring({ BWM_DATA_KEK_V2: secret(4), BWM_LOOKUP_HMAC_V2: secret(5) }, config)
    expect(ring.dataKekVersions).toEqual([2, 1])
    expect(ring.lookupKeyVersions).toEqual([2, 1])
    expect(ring.activeDataKekVersion).toBe(1)
    expect(ring.getDataKek(1)).toMatchObject({ extractable: false, usages: ['encrypt', 'decrypt'] })
    expect(ring.getLookupHmac(1)).toMatchObject({ extractable: false, usages: ['sign'] })
    expect(ring.getBackupKek(1)).toMatchObject({ extractable: false, usages: ['encrypt', 'decrypt'] })
    expect(ring.getDataKek(99)).toBeNull()
    expect(Object.isFrozen(ring)).toBe(true)
    expect(Object.isFrozen(ring.dataKekVersions)).toBe(true)
    expect(JSON.stringify(ring)).not.toContain(secret(1))
  })

  it.each([
    [{ BWM_DATA_KEK_V01: secret(1) }, 'BWM_DATA_KEK_V01'],
    [{ BWM_LOOKUP_HMAC_V0: secret(2) }, 'BWM_LOOKUP_HMAC_V0'],
    [{ BWM_BACKUP_KEK_V9007199254740992: secret(3) }, 'BWM_BACKUP_KEK_V9007199254740992'],
    [{ BWM_DATA_KEK_V2: 'not_a_key' }, 'BWM_DATA_KEK_V2'],
    [{ BWM_LOOKUP_HMAC_V2: encodeBase64Url(new Uint8Array(31)) }, 'BWM_LOOKUP_HMAC_V2'],
  ])('rejects every malformed present reserved binding', async (binding, name) => {
    await expect(keyring(binding)).rejects.toThrow(`KEYRING_INVALID:${name}`)
  })

  it('rejects missing active versions', async () => {
    await expect(keyring({ BWM_DATA_KEK_V1: undefined }, config)).rejects.toThrow('KEYRING_INVALID:BWM_DATA_KEK_V1')
  })

  it.each([undefined, null, {}, 1])('rejects present malformed historical bindings of type %s', async (value) => {
    await expect(createKeyring({
      BWM_DATA_KEK_V1: secret(1),
      BWM_LOOKUP_HMAC_V1: secret(2),
      BWM_BACKUP_KEK_V1: secret(3),
      BWM_DATA_KEK_V2: value,
    }, config)).rejects.toThrow('KEYRING_INVALID:BWM_DATA_KEK_V2')
  })
})

describe('scoped field encryption', () => {
  it('creates an exact wrapped row, stores no plaintext, and round-trips only under identical scope/AAD', async () => {
    const ring = await keyring()
    const marker = 'marker-secret@example.test'
    const dataKey = await getOrCreateDataKey(env.DB, ring, scope, { id: 'key_crypto_roundtrip', createdAt: now })
    const envelope = await encryptForScope(ring, dataKey, { expectedScope: scope, recordId: 'stf_1', field: 'email', plaintext: marker })
    const stored = await env.DB.prepare('SELECT * FROM data_keys WHERE id = ?').bind(dataKey.id).first()
    expect(Object.keys(stored).sort()).toEqual(rowKeys)
    expect(Object.keys(envelope).sort()).toEqual(envelopeKeys)
    expect(JSON.stringify({ stored, envelope })).not.toContain(marker)
    await expect(decryptForScope(ring, dataKey, { expectedScope: scope, recordId: 'stf_1', field: 'email', envelope })).resolves.toBe(marker)
    for (const expectedScope of [
      { ...scope, type: 'other_scope' },
      { ...scope, id: 'other_centre' },
      { ...scope, purpose: 'other_purpose' },
      { ...scope, extra: 'not_authorized' },
    ]) await cryptoFailure(decryptForScope(ring, dataKey, { expectedScope, recordId: 'stf_1', field: 'email', envelope }))
    for (const input of [
      { recordId: 'stf_2', field: 'email' },
      { recordId: 'stf_1', field: 'display_name' },
    ]) await cryptoFailure(decryptForScope(ring, dataKey, { expectedScope: scope, envelope, ...input }))
  })

  it.each([
    { ...scope, type: new String('staff_directory') },
    { ...scope, id: 42 },
    { ...scope, purpose: new String('identity') },
  ])('rejects non-primitive scope components', async (badScope) => {
    await cryptoFailure(createWrappedDataKey(await keyring(), { scope: badScope, id: 'key_scope_type', createdAt: now }))
  })

  it('uses fresh nonce material and collapses row, wrap, envelope, scope, and UTF-8 failures', async () => {
    const ring = await keyring()
    const dataKey = await createWrappedDataKey(ring, { scope, id: 'key_crypto_tamper', createdAt: now })
    const first = await encryptForScope(ring, dataKey, { expectedScope: scope, recordId: 'stf_tamper', field: 'email', plaintext: 'tamper@example.test' })
    const second = await encryptForScope(ring, dataKey, { expectedScope: scope, recordId: 'stf_tamper', field: 'email', plaintext: 'tamper@example.test' })
    expect(first.nonce).not.toBe(second.nonce)
    const invalids = [
      { ...first, nonce: flip(first.nonce) },
      { ...first, ciphertext: flip(first.ciphertext) },
      { ...first, dataKeyId: 'other_key' },
      { ...first, dataKeyVersion: 2 },
      { ...first, format: 2 },
      { ...first, algorithm: 'A128GCM' },
      { ...first, extra: true },
      { ...first, nonce: encodeBase64Url(new Uint8Array(11)) },
      { ...first, ciphertext: encodeBase64Url(new Uint8Array(15)) },
    ]
    for (const envelope of invalids) await cryptoFailure(decryptForScope(ring, dataKey, { expectedScope: scope, recordId: 'stf_tamper', field: 'email', envelope }))
    for (const badRow of [
      { ...dataKey, wrapped_key_b64: flip(dataKey.wrapped_key_b64) },
      { ...dataKey, wrap_nonce_b64: flip(dataKey.wrap_nonce_b64) },
      { ...dataKey, wrapped_key_b64: encodeBase64Url(new Uint8Array(47)) },
      { ...dataKey, scope_id: 'other_centre' },
      { ...dataKey, kek_version: 99 },
      { ...dataKey, dek_version: 0 },
      { ...dataKey, unexpected: true },
    ]) await cryptoFailure(decryptForScope(ring, badRow, { expectedScope: scope, recordId: 'stf_tamper', field: 'email', envelope: first }))
  })

  it('loads only the exact expected scope and envelope key identity', async () => {
    const ring = await keyring()
    const row = await getOrCreateDataKey(env.DB, ring, scope, { id: 'key_crypto_load', createdAt: now })
    const envelope = await encryptForScope(ring, row, { expectedScope: scope, recordId: 'stf_load', field: 'email', plaintext: 'load@example.test' })
    await expect(loadDataKey(env.DB, { envelope, expectedScope: scope })).resolves.toMatchObject({ id: row.id })
    await cryptoFailure(loadDataKey(env.DB, { envelope, expectedScope: { ...scope, purpose: 'other_purpose' } }))
  })

  it('rejects noncanonical persisted timestamps on creation, decrypt, and rewrap', async () => {
    const legacy = await keyring()
    const ring = await keyring({ BWM_DATA_KEK_V2: secret(4) }, { ...config, activeDataKekVersion: 2 })
    await cryptoFailure(createWrappedDataKey(ring, { scope, id: 'key_bad_created', createdAt: '2026-07-29 10:00:00Z' }))
    const original = await createWrappedDataKey(legacy, { scope, id: 'key_bad_retired', createdAt: now })
    const envelope = await encryptForScope(legacy, original, { expectedScope: scope, recordId: 'stf_dates', field: 'email', plaintext: 'dates@example.test' })
    for (const retired_at of ['', 'not-a-date', '2026-07-29T10:00:00Z', '2026-02-30T10:00:00.000Z']) {
      const row = { ...original, retired_at }
      await cryptoFailure(decryptForScope(legacy, row, { expectedScope: scope, recordId: 'stf_dates', field: 'email', envelope }))
      await cryptoFailure(rewrapDataKey(ring, row, { targetKekVersion: 2 }))
    }
  })

  it('rejects unsafe AAD components and missing historical KEKs without exposing source details', async () => {
    const v1 = await keyring()
    await cryptoFailure(createWrappedDataKey(v1, { scope: { ...scope, purpose: 'identity\nother' }, id: 'key_bad_scope', createdAt: now }))
    await cryptoFailure(createWrappedDataKey(v1, { scope, id: 'key_bad_version', dekVersion: Number.MAX_SAFE_INTEGER + 1, createdAt: now }))
    const row = await createWrappedDataKey(v1, { scope: { ...scope, id: 'centre_historical' }, id: 'key_historical', createdAt: now })
    const envelope = await encryptForScope(v1, row, { expectedScope: { ...scope, id: 'centre_historical' }, recordId: 'stf_history', field: 'email', plaintext: 'history@example.test' })
    const v2Only = await createKeyring({
      BWM_DATA_KEK_V2: secret(4),
      BWM_LOOKUP_HMAC_V1: secret(2),
      BWM_BACKUP_KEK_V1: secret(3),
    }, { ...config, activeDataKekVersion: 2 })
    await cryptoFailure(decryptForScope(v2Only, row, { expectedScope: { ...scope, id: 'centre_historical' }, recordId: 'stf_history', field: 'email', envelope }))
  })

  it('preserves a concurrent exact-scope winner and propagates unrelated insert collisions', async () => {
    const ring = await keyring()
    const concurrentScope = { ...scope, id: 'centre_race' }
    const [one, two] = await Promise.all([
      getOrCreateDataKey(env.DB, ring, concurrentScope, { id: 'key_race_one', createdAt: now }),
      getOrCreateDataKey(env.DB, ring, concurrentScope, { id: 'key_race_two', createdAt: now }),
    ])
    expect(one.id).toBe(two.id)
    await getOrCreateDataKey(env.DB, ring, { ...scope, id: 'centre_collision' }, { id: 'key_collision', createdAt: now })
    await expect(getOrCreateDataKey(env.DB, ring, { ...scope, id: 'centre_other' }, { id: 'key_collision', createdAt: now })).rejects.toThrow('identity_collision')
  })

  it('validates existing and collision winners and only recovers recognized exact races', async () => {
    const ring = await keyring()
    const row = await createWrappedDataKey(ring, { scope: { ...scope, id: 'centre_mock' }, id: 'key_mock', createdAt: now })
    const mockDb = (...responses) => ({
      prepare: () => ({ bind: () => ({
        first: async () => responses.shift().first(),
        run: async () => responses.shift().run(),
      }) }),
    })
    await cryptoFailure(getOrCreateDataKey(mockDb({ first: () => ({ ...row, created_at: 'bad' }) }), ring, rowScope(row), { id: 'key_unused', createdAt: now }))
    const transport = new Error('transport down')
    await expect(getOrCreateDataKey(mockDb(
      { first: () => null },
      { run: () => { throw transport } },
      { first: () => row },
    ), ring, rowScope(row), { id: 'key_transport', createdAt: now })).rejects.toBe(transport)
    const collision = new Error('identity_collision')
    await expect(getOrCreateDataKey(mockDb(
      { first: () => null },
      { run: () => { throw collision } },
      { first: () => { throw new Error('recovery failure') } },
    ), ring, rowScope(row), { id: 'key_recovery', createdAt: now })).rejects.toBe(collision)
    await cryptoFailure(getOrCreateDataKey(mockDb(
      { first: () => null },
      { run: () => { throw collision } },
      { first: () => ({ ...row, retired_at: 'bad' }) },
    ), ring, rowScope(row), { id: 'key_bad_winner', createdAt: now }))
    await expect(getOrCreateDataKey(mockDb(
      { first: () => null },
      { run: () => { throw collision } },
      { first: () => row },
    ), ring, rowScope(row), { id: 'key_race', createdAt: now })).resolves.toEqual(row)
  })

  it.each([
    'transport identity_collision downstream',
    'transport: identity_collision: downstream',
  ])('does not recover an arbitrary transport message containing the collision sentinel: %s', async (message) => {
    const ring = await keyring()
    const scope = { type: 'staff_directory', id: 'centre_transport_sentinel', purpose: 'identity' }
    const row = await createWrappedDataKey(ring, { scope, id: 'key_transport_sentinel', createdAt: now })
    const transport = new Error(message)
    let selects = 0
    const db = {
      prepare: (sql) => ({ bind: () => (sql.includes('SELECT') ? {
        first: async () => {
          selects += 1
          return selects === 1 ? null : row
        },
      } : { run: async () => { throw transport } }) }),
    }
    await expect(getOrCreateDataKey(db, ring, scope, { id: 'key_transport_attempt', createdAt: now })).rejects.toBe(transport)
    expect(selects).toBe(1)
  })

  it('decrypts and rewraps retired V1 rows but does not encrypt them, returning a frozen fresh-nonce CAS patch', async () => {
    const v1 = await keyring()
    const row = await createWrappedDataKey(v1, { scope: { ...scope, id: 'centre_rotate' }, id: 'key_rotate', createdAt: now })
    const expectedScope = { ...scope, id: 'centre_rotate' }
    const envelope = await encryptForScope(v1, row, { expectedScope, recordId: 'stf_rotate', field: 'email', plaintext: 'rotate@example.test' })
    const v2 = await keyring({ BWM_DATA_KEK_V2: secret(4) }, { ...config, activeDataKekVersion: 2 })
    await expect(decryptForScope(v2, row, { expectedScope, recordId: 'stf_rotate', field: 'email', envelope })).resolves.toBe('rotate@example.test')
    const retired = { ...row, retired_at: now }
    await cryptoFailure(encryptForScope(v2, retired, { expectedScope, recordId: 'stf_rotate', field: 'email', plaintext: 'nope@example.test' }))
    const patch = await rewrapDataKey(v2, retired, { targetKekVersion: 2 })
    expect(Object.isFrozen(patch)).toBe(true)
    expect(Object.isFrozen(patch.where)).toBe(true)
    expect(Object.isFrozen(patch.set)).toBe(true)
    expect(patch).toEqual({
      where: { id: row.id, scope_type: expectedScope.type, scope_id: expectedScope.id, purpose: expectedScope.purpose, dek_version: 1, wrapped_key_b64: row.wrapped_key_b64, wrap_nonce_b64: row.wrap_nonce_b64, kek_version: 1 },
      set: expect.objectContaining({ kek_version: 2 }),
    })
    expect(patch.set.wrap_nonce_b64).not.toBe(row.wrap_nonce_b64)
    const rewrapped = { ...row, ...patch.set }
    await expect(decryptForScope(v2, rewrapped, { expectedScope, recordId: 'stf_rotate', field: 'email', envelope })).resolves.toBe('rotate@example.test')
    for (const targetKekVersion of [1, 0, 3]) await cryptoFailure(rewrapDataKey(v2, row, { targetKekVersion }))
    await cryptoFailure(rewrapDataKey(v2, { ...row, wrapped_key_b64: flip(row.wrapped_key_b64) }, { targetKekVersion: 2 }))
  })

  it('does not serialize or log plaintext while creating data keys', async () => {
    const ring = await keyring()
    const calls = []
    const original = console.log
    console.log = (...args) => calls.push(args)
    try {
      const row = await getOrCreateDataKey(env.DB, ring, { ...scope, id: 'centre_no_leak' }, { id: 'key_no_leak', createdAt: now })
      const envelope = await encryptForScope(ring, row, { expectedScope: { ...scope, id: 'centre_no_leak' }, recordId: 'stf_no_leak', field: 'email', plaintext: 'no-log@example.test' })
      expect(JSON.stringify({ row, envelope, calls })).not.toContain('no-log@example.test')
      expect((await env.ARCHIVE.list()).objects).toEqual([])
    } finally { console.log = original }
  })

  it('zeroes the generated DEK when nonce generation fails', async () => {
    const ring = await keyring()
    const original = crypto.getRandomValues.bind(crypto)
    let calls = 0
    let dek
    const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation((value) => {
      calls += 1
      if (calls === 1) {
        dek = value
        value.fill(7)
        return value
      }
      throw new Error('random failure')
    })
    try {
      await cryptoFailure(createWrappedDataKey(ring, { scope, id: 'key_random_failure', createdAt: now }))
      expect([...dek]).toEqual(new Array(32).fill(0))
    } finally {
      random.mockRestore()
      void original
    }
  })

  it('collapses fatal UTF-8 decode failures after authenticated decryption', async () => {
    const ring = await keyring()
    const dataKey = await createWrappedDataKey(ring, { scope: { ...scope, id: 'centre_utf8' }, id: 'key_utf8', createdAt: now })
    const expectedScope = { ...scope, id: 'centre_utf8' }
    const envelope = await encryptForScope(ring, dataKey, { expectedScope, recordId: 'stf_utf8', field: 'email', plaintext: 'utf8@example.test' })
    const original = crypto.subtle.decrypt.bind(crypto.subtle)
    let calls = 0
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      calls += 1
      return calls === 2 ? new Uint8Array([0xc3]).buffer : original(...args)
    })
    try {
      await cryptoFailure(decryptForScope(ring, dataKey, { expectedScope, recordId: 'stf_utf8', field: 'email', envelope }))
    } finally { decrypt.mockRestore() }
  })
})

describe('blind email indexes', () => {
  it('normalizes exactly, uses active prefix, and returns all retained keys descending', async () => {
    const ring = await keyring({ BWM_LOOKUP_HMAC_V2: secret(5), BWM_LOOKUP_HMAC_V3: secret(6) }, { ...config, activeLookupKeyVersion: 2 })
    expect(await blindEmailIndex(' Staff@Example.Test ', ring)).toBe(await blindEmailIndex('staff@example.test', ring))
    expect(await blindEmailIndex('staff@example.test', ring)).toMatch(/^v2:/)
    expect((await blindEmailCandidates('staff@example.test', ring)).map((value) => value.slice(0, 3))).toEqual(['v3:', 'v2:', 'v1:'])
    await expect(blindEmailIndex(' ', ring)).rejects.toThrow()
  })
})
