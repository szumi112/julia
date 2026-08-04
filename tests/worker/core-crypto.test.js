import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { createKeyring } from '../../worker/security/keyring.js'
import { decryptForScope } from '../../worker/security/envelope.js'
import { decodeBase64Url, encodeBase64Url } from '../../worker/security/encoding.js'
import {
  assertClientKeyScope,
  buildClientDataKey,
  clientKeyScope,
  decryptClientCorrectionReason,
  decryptClientIdentity,
  encryptClientCorrectionReason,
  encryptClientIdentity,
  loadClientCryptoContext,
} from '../../worker/core/crypto.js'
import { buildRecordVersion } from '../../worker/core/versions.js'

const now = '2026-08-04T10:00:00.000Z'
const actorId = 'stf_core_crypto'
const correlationId = 'corr_core_crypto'

const ring = () => createKeyring(env, {
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
  activeBackupKekVersion: 1,
})

const captureDb = (db = env.DB) => {
  const calls = []
  return {
    calls,
    prepare(sql) {
      const inner = db.prepare(sql)
      return {
        bind(...values) {
          calls.push({ sql, values })
          return inner.bind(...values)
        },
      }
    },
  }
}

const cryptoFailure = (operation) => expect(operation).rejects.toThrow(/^CRYPTO_FAILURE$/)
const tamper = (value) => {
  const bytes = decodeBase64Url(value)
  bytes[Math.floor(bytes.length / 2)] ^= 1
  return encodeBase64Url(bytes)
}

const contextFor = async (clientId, suffix) => {
  const keyring = await ring()
  const built = await buildClientDataKey(env.DB, keyring, {
    clientId, dataKeyId: `key_${suffix}`, createdAt: now,
  })
  return { keyring, built, context: { keyring, dataKey: built.row, scope: built.scope } }
}

describe('client crypto boundary', () => {
  it('accepts only the exact client identity key scope', () => {
    expect(clientKeyScope('cl_crypto_scope')).toEqual({
      type: 'client', id: 'cl_crypto_scope', purpose: 'identity',
    })
    expect(assertClientKeyScope({ type: 'client', id: 'cl_crypto_scope', purpose: 'identity' }))
      .toEqual({ type: 'client', id: 'cl_crypto_scope', purpose: 'identity' })
    for (const scope of [
      { type: 'staff_directory', id: 'cl_crypto_scope', purpose: 'identity' },
      { type: 'client', id: 'sp_crypto_scope', purpose: 'identity' },
      { type: 'client', id: 'cl_crypto_scope', purpose: 'records' },
      { type: 'client', id: 'cl_crypto_scope', purpose: 'identity', extra: true },
      { type: 'client', id: 'cl_crypto_scope' },
    ]) expect(() => assertClientKeyScope(scope)).toThrow(/^CRYPTO_FAILURE$/)
    expect(() => clientKeyScope('client_without_prefix')).toThrow(/^CRYPTO_FAILURE$/)
  })

  it('builds a fresh wrapped-key insert without reading or writing outside the caller batch', async () => {
    const keyring = await ring()
    const db = captureDb()
    const before = await env.DB.prepare(
      "SELECT count(*) AS count FROM data_keys WHERE scope_type='client' AND scope_id=?"
    ).bind('cl_crypto_build').first()
    const built = await buildClientDataKey(db, keyring, {
      clientId: 'cl_crypto_build', dataKeyId: 'key_client_crypto_build', createdAt: now,
    })

    expect(before.count).toBe(0)
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql.replace(/\s+/g, ' ').trim()).toBe(
      'INSERT INTO data_keys (id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64, wrap_nonce_b64, kek_version, created_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    expect(db.calls[0].values).toEqual([
      'key_client_crypto_build', 'client', 'cl_crypto_build', 'identity', 1,
      expect.any(String), expect.any(String), 1, now, null,
    ])
    expect(built).toEqual({
      row: {
        id: 'key_client_crypto_build', scope_type: 'client', scope_id: 'cl_crypto_build',
        purpose: 'identity', dek_version: 1, wrapped_key_b64: expect.any(String),
        wrap_nonce_b64: expect.any(String), kek_version: 1, created_at: now, retired_at: null,
      },
      scope: { type: 'client', id: 'cl_crypto_build', purpose: 'identity' },
      statement: expect.any(Object),
    })
    expect(JSON.stringify(built)).not.toContain('name')
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM data_keys WHERE scope_type='client' AND scope_id=?"
    ).bind('cl_crypto_build').first()).count).toBe(0)

    await env.DB.batch([built.statement])
    const stored = await env.DB.prepare('SELECT * FROM data_keys WHERE id=?')
      .bind('key_client_crypto_build').first()
    expect(stored).toEqual(built.row)
    expect(JSON.stringify(stored)).not.toContain('Ada')
  })

  it('rejects malformed key-builder input before preparing D1', async () => {
    const keyring = await ring()
    for (const input of [
      { clientId: 'sp_wrong', dataKeyId: 'key_wrong_client', createdAt: now },
      { clientId: 'cl_wrong_key', dataKeyId: '', createdAt: now },
      { clientId: 'cl_wrong_time', dataKeyId: 'key_wrong_time', createdAt: '2026-08-04T10:00:00Z' },
      { clientId: 'cl_extra', dataKeyId: 'key_extra', createdAt: now, extra: true },
    ]) {
      const db = captureDb()
      await cryptoFailure(buildClientDataKey(db, keyring, input))
      expect(db.calls).toEqual([])
    }
  })

  it('encrypts exact canonical identity and persists ciphertext only', async () => {
    const { keyring, built, context } = await contextFor('cl_crypto_identity', 'crypto_identity')
    const identityEnvelope = await encryptClientIdentity(context, {
      clientId: 'cl_crypto_identity', name: 'Ada Fikcyjna', age: 8,
    })
    expect(typeof identityEnvelope).toBe('string')
    expect(identityEnvelope).not.toContain('Ada Fikcyjna')
    expect(Object.keys(JSON.parse(identityEnvelope)).sort()).toEqual([
      'algorithm', 'ciphertext', 'dataKeyId', 'dataKeyVersion', 'format', 'nonce',
    ])
    expect(await decryptForScope(keyring, built.row, {
      expectedScope: built.scope,
      recordId: 'cl_crypto_identity',
      field: 'identity',
      envelope: JSON.parse(identityEnvelope),
    })).toBe('{"schema":"client.identity.v1","name":"Ada Fikcyjna","age":8}')
    await expect(decryptClientIdentity(context, {
      clientId: 'cl_crypto_identity', envelope: identityEnvelope,
    })).resolves.toEqual({ name: 'Ada Fikcyjna', age: 8 })

    const clientStatement = env.DB.prepare(
      `INSERT INTO clients
       (id,identity_envelope,status,version,archived_at,created_at,updated_at)
       VALUES (?,?,'active',1,NULL,?,?)`
    ).bind('cl_crypto_identity', identityEnvelope, now, now)
    await env.DB.batch([built.statement, clientStatement])
    const stored = await env.DB.prepare('SELECT * FROM clients WHERE id=?')
      .bind('cl_crypto_identity').first()
    expect(stored.identity_envelope).toBe(identityEnvelope)
    expect(JSON.stringify(stored)).not.toContain('Ada Fikcyjna')

    const loaded = await loadClientCryptoContext(env.DB, keyring, {
      clientId: 'cl_crypto_identity', envelope: identityEnvelope,
    })
    await expect(decryptClientIdentity(loaded, {
      clientId: 'cl_crypto_identity', envelope: identityEnvelope,
    })).resolves.toEqual({ name: 'Ada Fikcyjna', age: 8 })
  })

  it('rejects excluded identity fields and every cross-client scope use', async () => {
    const { context } = await contextFor('cl_crypto_owner', 'crypto_owner')
    await cryptoFailure(encryptClientIdentity(context, {
      clientId: 'cl_crypto_owner', name: 'Fikcyjna Osoba', age: null, email: 'secret@example.test',
    }))
    await cryptoFailure(encryptClientIdentity(context, {
      clientId: 'cl_crypto_other', name: 'Fikcyjna Osoba', age: null,
    }))
    await cryptoFailure(encryptClientIdentity({
      ...context, scope: { ...context.scope, extra: true },
    }, { clientId: 'cl_crypto_owner', name: 'Fikcyjna Osoba', age: null }))
  })

  it('loads retained retired keys for historical reads but refuses new encryption', async () => {
    const { keyring, built, context } = await contextFor('cl_crypto_retired', 'crypto_retired')
    const envelope = await encryptClientIdentity(context, {
      clientId: 'cl_crypto_retired', name: 'Historyczna Osoba', age: 12,
    })
    await env.DB.batch([built.statement])
    await env.DB.prepare('UPDATE data_keys SET retired_at=? WHERE id=?')
      .bind(now, built.row.id).run()
    const retired = await loadClientCryptoContext(env.DB, keyring, {
      clientId: 'cl_crypto_retired', envelope,
    })
    await expect(decryptClientIdentity(retired, {
      clientId: 'cl_crypto_retired', envelope,
    })).resolves.toEqual({ name: 'Historyczna Osoba', age: 12 })
    await cryptoFailure(encryptClientIdentity(retired, {
      clientId: 'cl_crypto_retired', name: 'Nowa Osoba', age: 13,
    }))
  })

  it('fails closed for missing, malformed, tampered, wrong-version, and wrong-AAD envelopes', async () => {
    const { keyring, built, context } = await contextFor('cl_crypto_closed', 'crypto_closed')
    const serialized = await encryptClientIdentity(context, {
      clientId: 'cl_crypto_closed', name: 'Zamknięta Osoba', age: null,
    })
    const envelope = JSON.parse(serialized)
    await cryptoFailure(loadClientCryptoContext(env.DB, keyring, {
      clientId: 'cl_crypto_closed', envelope: serialized,
    }))
    await env.DB.batch([built.statement])
    for (const candidate of [
      'not-json',
      JSON.stringify({ ...envelope, ciphertext: tamper(envelope.ciphertext) }),
      JSON.stringify({ ...envelope, dataKeyVersion: 2 }),
      JSON.stringify({ ...envelope, format: 2 }),
      JSON.stringify({ ...envelope, extra: true }),
    ]) await cryptoFailure(decryptClientIdentity(context, {
      clientId: 'cl_crypto_closed', envelope: candidate,
    }))
    await cryptoFailure(decryptClientIdentity(context, {
      clientId: 'cl_crypto_wrong_aad', envelope: serialized,
    }))
    await cryptoFailure(loadClientCryptoContext(env.DB, keyring, {
      clientId: 'cl_crypto_other', envelope: serialized,
    }))

    const erasedDb = {
      prepare: () => ({ bind: () => ({ first: async () => ({
        ...built.row, wrapped_key_b64: '',
      }) }) }),
    }
    await cryptoFailure(loadClientCryptoContext(erasedDb, keyring, {
      clientId: 'cl_crypto_closed', envelope: serialized,
    }))
  })

  it('binds correction reasons to the owning client and exact correction AAD', async () => {
    const { context } = await contextFor('cl_crypto_reason', 'crypto_reason')
    const envelope = await encryptClientCorrectionReason(context, {
      correctionId: 'cor_crypto_reason', reason: 'Korekta fikcyjnej wpłaty',
    })
    expect(envelope).not.toContain('Korekta fikcyjnej wpłaty')
    await expect(decryptClientCorrectionReason(context, {
      correctionId: 'cor_crypto_reason', envelope,
    })).resolves.toBe('Korekta fikcyjnej wpłaty')
    await cryptoFailure(decryptClientCorrectionReason(context, {
      correctionId: 'cor_crypto_other', envelope,
    }))
    await cryptoFailure(encryptClientCorrectionReason(context, {
      correctionId: 'apt_wrong', reason: 'Korekta fikcyjnej wpłaty',
    }))
    await cryptoFailure(encryptClientCorrectionReason(context, {
      correctionId: 'cor_crypto_reason', reason: ' Korekta fikcyjnej wpłaty',
    }))
  })

  it('clears observable plaintext and raw-key buffers after successful encrypt and decrypt', async () => {
    const { context } = await contextFor('cl_crypto_wipe', 'crypto_wipe')
    const encryptedInputs = []
    const decryptedOutputs = []
    const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle)
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
      const input = args[2]
      encryptedInputs.push(new Uint8Array(input.buffer, input.byteOffset, input.byteLength))
      return originalEncrypt(...args)
    })
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      const result = await originalDecrypt(...args)
      decryptedOutputs.push(new Uint8Array(result))
      return result
    })
    try {
      const envelope = await encryptClientIdentity(context, {
        clientId: 'cl_crypto_wipe', name: 'Bufor Fikcyjny', age: 7,
      })
      await decryptClientIdentity(context, { clientId: 'cl_crypto_wipe', envelope })
    } finally {
      encryptSpy.mockRestore()
      decryptSpy.mockRestore()
    }
    expect(encryptedInputs.length).toBeGreaterThan(0)
    expect(decryptedOutputs.length).toBeGreaterThan(0)
    for (const bytes of [...encryptedInputs, ...decryptedOutputs]) {
      expect([...bytes]).toEqual(new Array(bytes.byteLength).fill(0))
    }
  })

  it('clears the observable plaintext buffer when encryption fails', async () => {
    const { context } = await contextFor('cl_crypto_wipe_failure', 'crypto_wipe_failure')
    const captured = []
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (_algorithm, _key, input) => {
      captured.push(new Uint8Array(input.buffer, input.byteOffset, input.byteLength))
      throw new Error('injected encryption failure')
    })
    try {
      await cryptoFailure(encryptClientIdentity(context, {
        clientId: 'cl_crypto_wipe_failure', name: 'Błąd Fikcyjny', age: 6,
      }))
    } finally {
      spy.mockRestore()
    }
    expect(captured).toHaveLength(1)
    expect([...captured[0]]).toEqual(new Array(captured[0].byteLength).fill(0))
  })
})

describe('core record version encryption', () => {
  const client = {
    id: 'cl_version_client', name: 'Wersja Fikcyjna', age: 9, status: 'active',
    version: 1, archivedAt: null, createdAt: now, updatedAt: now,
  }
  const assignment = {
    id: 'asg_version_assignment', clientId: client.id, specialistId: 'sp_version_specialist',
    startsAt: now, endsAt: null, assignedByStaffId: actorId, version: 1,
    createdAt: now, updatedAt: now,
  }
  const appointment = {
    id: 'apt_version_appointment', clientId: client.id, specialistId: 'sp_version_specialist',
    serviceId: 'zajecia', startsAt: now, endsAt: '2026-08-04T10:50:00.000Z',
    timeZone: 'Europe/Warsaw', location: null, status: 'completed', source: 'panel',
    version: 2, cancelledAt: null, createdAt: now, updatedAt: now,
    paymentAggregate: { status: 'partial', collectedGrosze: 5000, outstandingGrosze: 13000 },
  }
  const charge = {
    id: 'chg_version_charge', appointmentId: appointment.id, serviceId: 'zajecia',
    expectedAmountGrosze: 18000, currency: 'PLN', version: 1,
    createdAt: now, updatedAt: now,
  }

  it('builds exact canonical client, assignment, appointment, and charge snapshots as bound ciphertext', async () => {
    const { keyring, built: key, context } = await contextFor(client.id, 'version_all')
    const db = captureDb()
    const cases = [
      ['client', client, 'ver_version_client', {
        age: 9, archivedAt: null, createdAt: now, id: client.id, name: 'Wersja Fikcyjna',
        schema: 'client.v1', status: 'active', updatedAt: now, version: 1,
      }],
      ['client_assignment', assignment, 'ver_version_assignment', {
        assignedByStaffId: actorId, clientId: client.id, createdAt: now, endsAt: null,
        id: assignment.id, schema: 'client_assignment.v1', specialistId: 'sp_version_specialist',
        startsAt: now, updatedAt: now, version: 1,
      }],
      ['appointment', appointment, 'ver_version_appointment', {
        cancelledAt: null, clientId: client.id, createdAt: now,
        endsAt: '2026-08-04T10:50:00.000Z', id: appointment.id, location: null,
        paymentAggregate: { collectedGrosze: 5000, outstandingGrosze: 13000, status: 'partial' },
        schema: 'appointment.v1', serviceId: 'zajecia', source: 'panel',
        specialistId: 'sp_version_specialist', startsAt: now, status: 'completed',
        timeZone: 'Europe/Warsaw', updatedAt: now, version: 2,
      }],
      ['session_charge', charge, 'ver_version_charge', {
        appointmentId: appointment.id, createdAt: now, currency: 'PLN',
        expectedAmountGrosze: 18000, id: charge.id, schema: 'session_charge.v1',
        serviceId: 'zajecia', updatedAt: now, version: 1,
      }],
    ]

    const statements = [key.statement]
    for (const [entityType, entity, versionId, expected] of cases) {
      const result = await buildRecordVersion(db, context, {
        clientId: client.id, versionId, entityType, entity,
        changedByStaffId: null, changedAt: now, correlationId,
      })
      expect(Object.keys(result).sort()).toEqual(['row', 'statement'])
      expect(result.row).toEqual({
        id: versionId, entity_type: entityType, entity_id: entity.id,
        version: entity.version, snapshot_envelope: expect.any(String),
        changed_by_staff_id: null, changed_at: now, correlation_id: correlationId,
      })
      expect(JSON.stringify(result)).not.toContain('Wersja Fikcyjna')
      expect(JSON.stringify(db.calls.at(-1))).not.toContain('Wersja Fikcyjna')
      const plaintext = await decryptForScope(keyring, key.row, {
        expectedScope: key.scope, recordId: entity.id, field: 'record_version',
        envelope: JSON.parse(result.row.snapshot_envelope),
      })
      expect(plaintext).toBe(JSON.stringify(expected))
      statements.push(result.statement)
    }

    expect(db.calls).toHaveLength(4)
    for (const [index, call] of db.calls.entries()) {
      expect(call.sql.replace(/\s+/g, ' ').trim()).toBe(
        'INSERT INTO record_versions (id, entity_type, entity_id, version, snapshot_envelope, changed_by_staff_id, changed_at, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      expect(call.values).toEqual([
        cases[index][2], cases[index][0], cases[index][1].id, cases[index][1].version,
        expect.any(String), null, now, correlationId,
      ])
    }

    await env.DB.batch(statements)
    const stored = (await env.DB.prepare(
      'SELECT * FROM record_versions WHERE correlation_id=? ORDER BY entity_type'
    ).bind(correlationId).all()).results
    expect(stored).toHaveLength(4)
    expect(JSON.stringify(stored)).not.toContain('Wersja Fikcyjna')
    expect(stored.every((row) => row.snapshot_envelope.includes('ciphertext'))).toBe(true)
  })

  it('binds versions to exact client scope, entity prefixes, actor, and canonical row shape', async () => {
    const { context } = await contextFor(client.id, 'version_invalid')
    const db = captureDb()
    const valid = {
      clientId: client.id, versionId: 'ver_version_invalid', entityType: 'client',
      entity: client, changedByStaffId: actorId, changedAt: now, correlationId,
    }
    for (const overrides of [
      { clientId: 'cl_version_other' },
      { versionId: 'record_wrong_prefix' },
      { entityType: 'specialist' },
      { entityType: 'client', entity: { ...client, id: 'sp_wrong' } },
      { entityType: 'client', entity: { ...client, extra: true } },
      { entityType: 'client', entity: { ...client, updatedAt: 'bad' } },
      { changedByStaffId: 'cl_wrong_actor' },
      { changedAt: '2026-08-04T10:00:00Z' },
      { correlationId: '' },
      { extra: true },
    ]) await cryptoFailure(buildRecordVersion(db, context, { ...valid, ...overrides }))
    expect(db.calls).toEqual([])
  })
})
