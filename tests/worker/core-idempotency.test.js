import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  createIdempotencyStatement,
  inspectStoredScopeIdempotency,
  recoverStoredScopeIdempotencyAfterCollision,
} from '../../worker/db/unit-of-work.js'
import { buildClientDataKey } from '../../worker/core/crypto.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { decodeBase64Url, encodeBase64Url } from '../../worker/security/encoding.js'
import {
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'

const now = '2026-08-04T10:00:00.000Z'
const expiresAt = '2027-08-04T10:00:00.000Z'
const collision = () => new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT')
const normalized = (sql) => sql.replace(/\s+/g, ' ').trim()

const ring = () => createKeyring(env, {
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
  activeBackupKekVersion: 1,
})

const secret = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const isolatedRing = (version) => createKeyring({
  [`BWM_DATA_KEK_V${version}`]: secret(version),
  BWM_LOOKUP_HMAC_V1: secret(91),
  BWM_BACKUP_KEK_V1: secret(92),
}, {
  activeDataKekVersion: version,
  activeLookupKeyVersion: 1,
  activeBackupKekVersion: 1,
})

const digestFor = async (value) => {
  const bytes = new TextEncoder().encode(value)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  try { return encodeBase64Url(hash) } finally { bytes.fill(0); hash.fill(0) }
}

const recordIdFor = async (input) => digestFor(
  ['bwm:idempotency:record:v1', input.actorId, input.operation, input.idempotencyKey].join('\n')
).then((digest) => `idem_${digest}`)

const baseInput = async (suffix, request = `request-${suffix}`) => ({
  actorId: `stf_core_${suffix}`,
  operation: 'client.create',
  idempotencyKey: `idem-core-${suffix}-12345678`,
  requestDigest: await digestFor(request),
  resourceType: 'client',
  scopeType: 'client',
  scopePurpose: 'identity',
})

const storeWinner = async (suffix, options = {}) => {
  const keyring = options.keyring ?? await ring()
  const clientId = options.clientId ?? `cl_${suffix}`
  const input = options.input ?? await baseInput(suffix)
  const built = await buildClientDataKey(env.DB, keyring, {
    clientId,
    dataKeyId: `key_core_${suffix}`,
    createdAt: now,
  })
  await built.statement.run()
  const response = options.response ?? {
    status: 201,
    body: { data: { id: clientId, label: `Fikcyjny ${suffix}` } },
  }
  await (await createIdempotencyStatement(env.DB, {
    keyring,
    dataKey: built.row,
  }, {
    actorId: input.actorId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    requestDigest: input.requestDigest,
    expectedScope: built.scope,
    resourceType: 'client',
    resourceId: clientId,
    response,
    createdAt: now,
    expiresAt,
  })).run()
  return { keyring, clientId, input, built, response }
}

const observeDb = ({ mapRow = (row) => row, mapKey = (row) => row } = {}) => {
  const calls = []
  let mutations = 0
  const db = {
    prepare(sql) {
      const statement = env.DB.prepare(sql)
      return {
        bind(...values) {
          const query = normalized(sql)
          calls.push({ sql: query, values })
          const bound = statement.bind(...values)
          return {
            async first() {
              const row = await bound.first()
              if (query.includes('FROM idempotency_records')) return mapRow(row)
              if (query.includes('FROM data_keys')) return mapKey(row)
              return row
            },
            async run() {
              mutations += 1
              return bound.run()
            },
          }
        },
      }
    },
    async batch(statements) {
      mutations += 1
      return env.DB.batch(statements)
    },
  }
  return { db, calls, mutations: () => mutations }
}

const expectCryptoFailure = (operation) => expect(operation).rejects.toThrow(/^CRYPTO_FAILURE$/)
const tamperEnvelope = (serialized) => {
  const envelope = JSON.parse(serialized)
  const ciphertext = decodeBase64Url(envelope.ciphertext)
  ciphertext[Math.floor(ciphertext.length / 2)] ^= 1
  envelope.ciphertext = encodeBase64Url(ciphertext)
  ciphertext.fill(0)
  return JSON.stringify(envelope)
}

describe('stored-client-scope idempotency', () => {
  it('returns null after one exact authoritative-row query and never looks up a key', async () => {
    const input = await baseInput('absent')
    const calls = []
    const db = {
      prepare(sql) {
        return {
          bind(...values) {
            calls.push({ sql: normalized(sql), values })
            return { first: async () => null }
          },
        }
      },
    }

    await expect(inspectStoredScopeIdempotency(db, {}, input)).resolves.toBeNull()
    expect(calls).toEqual([{
      sql: 'SELECT request_hash,resource_type,resource_id,response_envelope FROM idempotency_records WHERE actor_id=? AND operation=? AND idempotency_key=?',
      values: [input.actorId, input.operation, input.idempotencyKey],
    }])
  })

  it.each([undefined, false, 0, '', NaN])(
    'treats the non-null first() result %s as malformed in inspect and recovery',
    async (malformed) => {
      const input = await baseInput(`absence_${String(malformed)}`.replaceAll('NaN', 'nan'))
      for (const recovery of [false, true]) {
        let queries = 0
        let mutations = 0
        const db = {
          prepare: () => ({
            bind: () => ({
              first: async () => { queries += 1; return malformed },
              run: async () => { mutations += 1 },
            }),
          }),
          batch: async () => { mutations += 1 },
        }
        const operation = recovery
          ? recoverStoredScopeIdempotencyAfterCollision(
            db, {}, input, collision(),
          )
          : inspectStoredScopeIdempotency(db, {}, input)
        await expectCryptoFailure(operation)
        expect(queries).toBe(1)
        expect(mutations).toBe(0)
      }
    },
  )

  it('captures only exact data properties and rejects every mixed or hostile input before D1', async () => {
    const valid = await baseInput('input')
    let prepares = 0
    const db = { prepare: () => { prepares += 1 } }
    let getterCalls = 0
    const accessor = { ...valid }
    Object.defineProperty(accessor, 'actorId', {
      enumerable: true,
      get() { getterCalls += 1; return valid.actorId },
    })
    const revoked = Proxy.revocable({ ...valid }, {})
    revoked.revoke()
    const invalid = [
      { ...valid, resourceType: 'appointment' },
      { ...valid, scopeType: 'staff_directory' },
      { ...valid, scopePurpose: 'records' },
      { ...valid, clientId: 'cl_caller_controlled' },
      { ...valid, requestDigest: `${valid.requestDigest}A` },
      { ...valid, requestDigest: `${valid.requestDigest.slice(0, -1)}B` },
      { ...valid, actorId: new String(valid.actorId) },
      accessor,
      new Proxy({ ...valid }, { ownKeys() { throw new Error('HOSTILE_INPUT') } }),
      revoked.proxy,
      Object.create(valid),
    ]
    for (const candidate of invalid) {
      await expect(inspectStoredScopeIdempotency(db, {}, candidate))
        .rejects.toThrow(/^IDEMPOTENCY_INVALID$/)
    }
    expect(getterCalls).toBe(0)
    expect(prepares).toBe(0)
  })

  it('derives the client scope from the stored ID and replays through exactly row plus key queries', async () => {
    const winner = await storeWinner('replay')
    const observed = observeDb()
    const replay = await inspectStoredScopeIdempotency(
      observed.db, winner.keyring, winner.input,
    )

    expect(replay).toEqual(winner.response)
    expect(Object.isFrozen(replay)).toBe(true)
    expect(observed.calls).toHaveLength(2)
    expect(observed.calls[0]).toEqual({
      sql: 'SELECT request_hash,resource_type,resource_id,response_envelope FROM idempotency_records WHERE actor_id=? AND operation=? AND idempotency_key=?',
      values: [winner.input.actorId, winner.input.operation, winner.input.idempotencyKey],
    })
    expect(observed.calls[1].sql).toBe(
      'SELECT id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64, wrap_nonce_b64, kek_version, created_at, retired_at FROM data_keys WHERE id = ? AND dek_version = ? AND scope_type = ? AND scope_id = ? AND purpose = ?'
    )
    expect(observed.calls[1].values).toEqual([
      winner.built.row.id, 1, 'client', winner.clientId, 'identity',
    ])
    expect(observed.calls.flatMap(({ values }) => values)).not.toContain('staff_directory')
    expect(observed.mutations()).toBe(0)
  })

  it('uses one descriptor snapshot for hostile but stable input and authoritative-row proxies', async () => {
    const winner = await storeWinner('snapshot')
    let inputGets = 0
    let rowGets = 0
    const proxiedInput = new Proxy(winner.input, {
      get() { inputGets += 1; return 'drift_input' },
    })
    const observed = observeDb({
      mapRow: (row) => new Proxy(row, {
        get(target, key) {
          if (key === 'then') return undefined
          rowGets += 1
          return Reflect.get(target, key)
        },
      }),
    })
    await expect(inspectStoredScopeIdempotency(
      observed.db, winner.keyring, proxiedInput,
    )).resolves.toEqual(winner.response)
    expect(inputGets).toBe(0)
    expect(rowGets).toBe(0)
    expect(observed.calls).toHaveLength(2)
  })

  it('keeps the authoritative row on a digest mismatch and reports only the fixed conflict', async () => {
    const winner = await storeWinner('conflict')
    const observed = observeDb()
    await expect(inspectStoredScopeIdempotency(observed.db, winner.keyring, {
      ...winner.input,
      requestDigest: await digestFor('different-request'),
    })).rejects.toThrow(/^IDEMPOTENCY_CONFLICT$/)
    expect(observed.calls).toHaveLength(2)
    expect(observed.mutations()).toBe(0)
  })

  it('authenticates and validates the response before deciding a valid digest conflict', async () => {
    const winner = await storeWinner('conflict_response')
    const recordId = await recordIdFor(winner.input)
    const malformedPlaintext = JSON.stringify(await encryptForScope(
      winner.keyring, winner.built.row, {
        expectedScope: winner.built.scope,
        recordId,
        field: 'idempotency_response',
        plaintext: 'not-json',
      },
    ))
    const different = {
      ...winner.input,
      requestDigest: await digestFor('different-conflict-response-request'),
    }
    for (const response_envelope of [
      tamperEnvelope((await env.DB.prepare(
        'SELECT response_envelope FROM idempotency_records WHERE actor_id=? AND operation=? AND idempotency_key=?'
      ).bind(
        winner.input.actorId, winner.input.operation, winner.input.idempotencyKey,
      ).first()).response_envelope),
      malformedPlaintext,
    ]) {
      const observed = observeDb({ mapRow: (row) => ({ ...row, response_envelope }) })
      await expectCryptoFailure(inspectStoredScopeIdempotency(
        observed.db, winner.keyring, different,
      ))
      expect(observed.calls).toHaveLength(2)
      expect(observed.mutations()).toBe(0)
    }
  })

  it('rejects authenticated malformed stored digest plaintext as crypto corruption', async () => {
    const winner = await storeWinner('malformed_digest')
    const recordId = await recordIdFor(winner.input)
    const malformedDigest = JSON.stringify(await encryptForScope(
      winner.keyring, winner.built.row, {
        expectedScope: winner.built.scope,
        recordId,
        field: 'idempotency_request_hash',
        plaintext: 'authenticated-but-not-a-sha256-digest',
      },
    ))
    const observed = observeDb({
      mapRow: (row) => ({ ...row, request_hash: malformedDigest }),
    })
    await expectCryptoFailure(inspectStoredScopeIdempotency(
      observed.db, winner.keyring, winner.input,
    ))
    expect(observed.calls).toHaveLength(2)
    expect(observed.mutations()).toBe(0)
  })

  it('rejects malformed authoritative row surfaces before any key lookup', async () => {
    const input = await baseInput('row')
    const base = {
      request_hash: '{}',
      resource_type: 'client',
      resource_id: 'cl_row',
      response_envelope: '{}',
    }
    let getterCalls = 0
    const accessor = { ...base }
    Object.defineProperty(accessor, 'resource_id', {
      enumerable: true,
      get() { getterCalls += 1; return 'cl_row' },
    })
    for (const row of [
      { ...base, resource_type: 'staff_user' },
      { ...base, resource_id: 'sp_row' },
      { ...base, extra: true },
      accessor,
      new Proxy({ ...base }, { ownKeys() { throw new Error('HOSTILE_ROW') } }),
    ]) {
      let calls = 0
      const db = {
        prepare: () => ({ bind: () => ({ first: async () => { calls += 1; return row } }) }),
      }
      await expectCryptoFailure(inspectStoredScopeIdempotency(db, {}, input))
      expect(calls).toBe(1)
    }
    expect(getterCalls).toBe(0)
  })

  it('fails closed after the exact key query for missing, erased, or staff-scoped key rows', async () => {
    const missing = await storeWinner('missing')
    const missingDb = observeDb({ mapKey: () => null })
    await expectCryptoFailure(inspectStoredScopeIdempotency(
      missingDb.db, missing.keyring, missing.input,
    ))
    expect(missingDb.calls).toHaveLength(2)
    expect(missingDb.mutations()).toBe(0)

    const erased = await storeWinner('erased')
    const erasedDb = observeDb({
      mapKey: (row) => ({ ...row, wrapped_key_b64: '' }),
    })
    await expectCryptoFailure(inspectStoredScopeIdempotency(
      erasedDb.db, erased.keyring, erased.input,
    ))
    expect(erasedDb.calls).toHaveLength(2)
    expect(erasedDb.mutations()).toBe(0)

    const keyring = await ring()
    const staffScope = {
      type: 'staff_directory', id: 'centre_core_staff_key', purpose: 'identity',
    }
    const staffKey = await getOrCreateDataKey(env.DB, keyring, staffScope, {
      id: 'key_core_staff_scope', createdAt: now,
    })
    const staffInput = await baseInput('staffkey')
    await (await createIdempotencyStatement(env.DB, { keyring, dataKey: staffKey }, {
      actorId: staffInput.actorId,
      operation: staffInput.operation,
      idempotencyKey: staffInput.idempotencyKey,
      requestDigest: staffInput.requestDigest,
      expectedScope: staffScope,
      resourceType: 'client',
      resourceId: 'cl_staffkey',
      response: { status: 201, body: { data: { id: 'cl_staffkey' } } },
      createdAt: now,
      expiresAt,
    })).run()
    const staffDb = observeDb()
    await expectCryptoFailure(inspectStoredScopeIdempotency(
      staffDb.db, keyring, staffInput,
    ))
    expect(staffDb.calls).toHaveLength(2)
    expect(staffDb.calls[1].values.slice(2)).toEqual([
      'client', 'cl_staffkey', 'identity',
    ])
    expect(staffDb.mutations()).toBe(0)
  })

  it('collapses wrong key versions, unwrap failures, hostile key rows, and retired-key absence', async () => {
    const winner = await storeWinner('keyfail')
    for (const mapKey of [
      (row) => ({ ...row, kek_version: 999 }),
      (row) => ({ ...row, wrapped_key_b64: encodeBase64Url(new Uint8Array(48)) }),
      (row) => new Proxy(row, { get() { throw new Error('HOSTILE_KEY_ROW') } }),
    ]) {
      const observed = observeDb({ mapKey })
      await expectCryptoFailure(inspectStoredScopeIdempotency(
        observed.db, winner.keyring, winner.input,
      ))
      expect(observed.calls).toHaveLength(2)
      expect(observed.mutations()).toBe(0)
    }

    const v1 = await isolatedRing(1)
    const historical = await storeWinner('retired_absent', { keyring: v1 })
    await env.DB.prepare('UPDATE data_keys SET retired_at=? WHERE id=?')
      .bind(now, historical.built.row.id).run()
    const v2Only = await isolatedRing(2)
    const observed = observeDb()
    await expectCryptoFailure(inspectStoredScopeIdempotency(
      observed.db, v2Only, historical.input,
    ))
    expect(observed.calls).toHaveLength(2)
    expect(observed.mutations()).toBe(0)
  })

  it('replays a retained retired client key without regenerating or mutating it', async () => {
    const winner = await storeWinner('retired')
    await env.DB.prepare('UPDATE data_keys SET retired_at=? WHERE id=?')
      .bind(now, winner.built.row.id).run()
    const observed = observeDb()
    await expect(inspectStoredScopeIdempotency(
      observed.db, winner.keyring, winner.input,
    )).resolves.toEqual(winner.response)
    expect(observed.calls).toHaveLength(2)
    expect(observed.mutations()).toBe(0)
  })

  it('authenticates both exact AADs and requires one shared envelope key/version', async () => {
    const winner = await storeWinner('aad')
    const recordId = await recordIdFor(winner.input)
    const wrongRequest = JSON.stringify(await encryptForScope(
      winner.keyring, winner.built.row, {
        expectedScope: winner.built.scope,
        recordId: 'idem_wrong_request_aad',
        field: 'idempotency_request_hash',
        plaintext: winner.input.requestDigest,
      },
    ))
    const wrongResponse = JSON.stringify(await encryptForScope(
      winner.keyring, winner.built.row, {
        expectedScope: winner.built.scope,
        recordId,
        field: 'record_version',
        plaintext: JSON.stringify(winner.response),
      },
    ))
    const other = await storeWinner('aad_other')
    const otherRow = await env.DB.prepare(
      'SELECT response_envelope FROM idempotency_records WHERE actor_id=? AND operation=? AND idempotency_key=?'
    ).bind(other.input.actorId, other.input.operation, other.input.idempotencyKey).first()

    for (const mapRow of [
      (row) => ({ ...row, request_hash: wrongRequest }),
      (row) => ({ ...row, response_envelope: wrongResponse }),
      (row) => ({ ...row, response_envelope: otherRow.response_envelope }),
    ]) {
      const observed = observeDb({ mapRow })
      await expectCryptoFailure(inspectStoredScopeIdempotency(
        observed.db, winner.keyring, winner.input,
      ))
      expect(observed.calls).toHaveLength(2)
      expect(observed.mutations()).toBe(0)
    }
  })

  it('rejects malformed and noncanonical stored envelopes without falling through', async () => {
    const winner = await storeWinner('envelope')
    const recordId = await recordIdFor(winner.input)
    const noncanonical = JSON.stringify(await encryptForScope(
      winner.keyring, winner.built.row, {
        expectedScope: winner.built.scope,
        recordId,
        field: 'idempotency_response',
        plaintext: '{"status":201,"body":{"z":1,"a":2}}',
      },
    ))
    const cases = [
      { calls: 1, mapRow: (row) => ({ ...row, request_hash: 'not-json' }) },
      { calls: 2, mapRow: (row) => ({ ...row, request_hash: tamperEnvelope(row.request_hash) }) },
      { calls: 2, mapRow: (row) => ({ ...row, response_envelope: 'not-json' }) },
      { calls: 2, mapRow: (row) => ({ ...row, response_envelope: tamperEnvelope(row.response_envelope) }) },
      { calls: 2, mapRow: (row) => ({
        ...row,
        response_envelope: JSON.stringify({
          ...JSON.parse(row.response_envelope), dataKeyVersion: 2,
        }),
      }) },
      { calls: 2, mapRow: (row) => ({ ...row, response_envelope: noncanonical }) },
    ]
    for (const candidate of cases) {
      const observed = observeDb({ mapRow: candidate.mapRow })
      await expectCryptoFailure(inspectStoredScopeIdempotency(
        observed.db, winner.keyring, winner.input,
      ))
      expect(observed.calls).toHaveLength(candidate.calls)
      expect(observed.mutations()).toBe(0)
    }
  })

  it('rethrows non-collisions and hostile classifiers as the original object without querying', async () => {
    const input = await baseInput('original')
    const transport = new Error('transport down')
    let prepares = 0
    const db = { prepare: () => { prepares += 1 } }
    await expect(recoverStoredScopeIdempotencyAfterCollision(
      db, {}, input, transport,
    )).rejects.toBe(transport)

    const hostile = {}
    Object.defineProperty(hostile, 'message', {
      get() { throw new Error('HOSTILE_MESSAGE') },
    })
    await expect(recoverStoredScopeIdempotencyAfterCollision(
      db, {}, input, hostile,
    )).rejects.toBe(hostile)
    expect(prepares).toBe(0)
  })

  it('rethrows an absent collision winner and recovers concurrent readers in exactly two queries each', async () => {
    const input = await baseInput('collision_absent')
    const original = collision()
    let calls = 0
    const emptyDb = {
      prepare: () => ({ bind: () => ({ first: async () => { calls += 1; return null } }) }),
    }
    await expect(recoverStoredScopeIdempotencyAfterCollision(
      emptyDb, {}, input, original,
    )).rejects.toBe(original)
    expect(calls).toBe(1)

    const winner = await storeWinner('collision')
    const first = observeDb()
    const second = observeDb()
    const recovered = await Promise.all([
      recoverStoredScopeIdempotencyAfterCollision(
        first.db, winner.keyring, winner.input, collision(),
      ),
      recoverStoredScopeIdempotencyAfterCollision(
        second.db, winner.keyring, winner.input, collision(),
      ),
    ])
    expect(recovered).toEqual([winner.response, winner.response])
    for (const observed of [first, second]) {
      expect(observed.calls).toHaveLength(2)
      expect(observed.mutations()).toBe(0)
    }
  })
})
