import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { auditEventStatement } from '../../worker/audit/events.js'
import { applyDataKeyRewrap } from '../../worker/security/data-key-rewrap.js'
import { decodeBase64Url, encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  createWrappedDataKey,
  decryptForScope,
  encryptForScope,
  rewrapDataKey,
} from '../../worker/security/envelope.js'

const now = '2027-01-15T08:00:00.000Z'
const correlationId = '11111111-1111-4111-8111-111111111111'
const flip = (value) => {
  const bytes = decodeBase64Url(value)
  bytes[0] ^= 1
  const result = encodeBase64Url(bytes)
  bytes.fill(0)
  return result
}

describe('data-key rewrap I/O boundary', () => {
  it('atomically applies exact CAS state with one audit', async () => {
    const keyring = await createKeyring({
      BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      BWM_DATA_KEK_V2: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
    }, { activeDataKekVersion: 2 })
    const legacy = await createWrappedDataKey(
      await createKeyring({ BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, { activeDataKekVersion: 1 }),
      { scope: { type: 'staff_directory', id: 'centre_rewrap_io', purpose: 'identity' }, id: 'key_rewrap_io', createdAt: now },
    )
    const expectedScope = {
      type: legacy.scope_type,
      id: legacy.scope_id,
      purpose: legacy.purpose,
    }
    const fieldEnvelope = await encryptForScope(
      await createKeyring({ BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, { activeDataKekVersion: 1 }),
      legacy,
      {
        expectedScope,
        recordId: 'stf_rewrap_payload',
        field: 'display_name',
        plaintext: 'Rewrap payload',
      }
    )
    await env.DB.prepare(
      `INSERT INTO data_keys
       (id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,kek_version,created_at,retired_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL)`
    ).bind(
      legacy.id, legacy.scope_type, legacy.scope_id, legacy.purpose, legacy.dek_version,
      legacy.wrapped_key_b64, legacy.wrap_nonce_b64, legacy.kek_version, legacy.created_at,
    ).run()
    await env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,version,created_at,updated_at)
       VALUES ('stf_rewrap_io','lookup_rewrap_io','{}','{}','owner','pending',1,?,?)`
    ).bind(now, now).run()
    const patch = await rewrapDataKey(keyring, legacy, { targetKekVersion: 2 })
    expect(patch.set.wrap_nonce_b64).not.toBe(legacy.wrap_nonce_b64)
    await applyDataKeyRewrap(env.DB, patch, {
      actorStaffId: 'stf_rewrap_io',
      correlationId,
      occurredAt: now,
      auditId: 'aud_rewrap_io',
    })
    expect(await env.DB.prepare("SELECT kek_version,wrap_nonce_b64 FROM data_keys WHERE id='key_rewrap_io'").first())
      .toEqual({ kek_version: 2, wrap_nonce_b64: patch.set.wrap_nonce_b64 })
    expect(await env.DB.prepare("SELECT action,metadata_json FROM audit_events WHERE id='aud_rewrap_io'").first())
      .toEqual({ action: 'data_key.rewrapped', metadata_json: '{"newKekVersion":2,"oldKekVersion":1}' })
    const rewrapped = await env.DB.prepare('SELECT * FROM data_keys WHERE id=?').bind(legacy.id).first()
    await expect(decryptForScope(keyring, rewrapped, {
      expectedScope,
      recordId: 'stf_rewrap_payload',
      field: 'display_name',
      envelope: fieldEnvelope,
    })).resolves.toBe('Rewrap payload')
  })

  it('rolls back the success audit when an exact CAS patch is stale', async () => {
    const v1 = await createKeyring({
      BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }, { activeDataKekVersion: 1 })
    const v2 = await createKeyring({
      BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      BWM_DATA_KEK_V2: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
    }, { activeDataKekVersion: 2 })
    const legacy = await createWrappedDataKey(v1, {
      scope: { type: 'staff_directory', id: 'centre_rewrap_stale', purpose: 'identity' },
      id: 'key_rewrap_stale',
      createdAt: now,
    })
    await env.DB.prepare(
      `INSERT INTO data_keys
       (id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,kek_version,created_at,retired_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL)`
    ).bind(
      legacy.id, legacy.scope_type, legacy.scope_id, legacy.purpose, legacy.dek_version,
      legacy.wrapped_key_b64, legacy.wrap_nonce_b64, legacy.kek_version, legacy.created_at,
    ).run()
    await env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,version,created_at,updated_at)
       VALUES ('stf_rewrap_stale','lookup_rewrap_stale','{}','{}','owner','pending',1,?,?)`
    ).bind(now, now).run()
    const winnerPatch = await rewrapDataKey(v2, legacy, { targetKekVersion: 2 })
    const stalePatch = await rewrapDataKey(v2, legacy, { targetKekVersion: 2 })
    await applyDataKeyRewrap(env.DB, winnerPatch, {
      actorStaffId: 'stf_rewrap_stale',
      correlationId,
      occurredAt: now,
      auditId: 'aud_rewrap_winner',
    })
    await expect(applyDataKeyRewrap(env.DB, stalePatch, {
      actorStaffId: 'stf_rewrap_stale',
      correlationId,
      occurredAt: now,
      auditId: 'aud_rewrap_loser',
    })).rejects.toThrow(/^VERSION_CONFLICT$/)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE id IN ('aud_rewrap_winner','aud_rewrap_loser')"
    ).first()).count).toBe(1)
    expect(await env.DB.prepare("SELECT id FROM audit_events WHERE id='aud_rewrap_loser'").first()).toBeNull()
  })

  it('requires this caller to change one row when the identical patch is replayed', async () => {
    const v1 = await createKeyring({
      BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }, { activeDataKekVersion: 1 })
    const v2 = await createKeyring({
      BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      BWM_DATA_KEK_V2: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
    }, { activeDataKekVersion: 2 })
    const legacy = await createWrappedDataKey(v1, {
      scope: { type: 'staff_directory', id: 'centre_rewrap_identical', purpose: 'identity' },
      id: 'key_rewrap_identical',
      createdAt: now,
    })
    await env.DB.prepare(
      `INSERT INTO data_keys
       (id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,kek_version,created_at,retired_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL)`
    ).bind(
      legacy.id, legacy.scope_type, legacy.scope_id, legacy.purpose, legacy.dek_version,
      legacy.wrapped_key_b64, legacy.wrap_nonce_b64, legacy.kek_version, legacy.created_at,
    ).run()
    await env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,version,created_at,updated_at)
       VALUES ('stf_rewrap_identical','lookup_rewrap_identical','{}','{}','owner','pending',1,?,?)`
    ).bind(now, now).run()
    const patch = await rewrapDataKey(v2, legacy, { targetKekVersion: 2 })
    await applyDataKeyRewrap(env.DB, patch, {
      actorStaffId: 'stf_rewrap_identical',
      correlationId,
      occurredAt: now,
      auditId: 'aud_rewrap_identical_winner',
    })
    await expect(applyDataKeyRewrap(env.DB, patch, {
      actorStaffId: 'stf_rewrap_identical',
      correlationId,
      occurredAt: now,
      auditId: 'aud_rewrap_identical_loser',
    })).rejects.toThrow(/^VERSION_CONFLICT$/)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE entity_id='key_rewrap_identical'"
    ).first()).count).toBe(1)
  })

  it('rejects every independently wrong CAS fact and rolls back ordinary audit collisions', async () => {
    const v1 = await createKeyring({
      BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }, { activeDataKekVersion: 1 })
    const v2 = await createKeyring({
      BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      BWM_DATA_KEK_V2: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
    }, { activeDataKekVersion: 2 })
    const legacy = await createWrappedDataKey(v1, {
      scope: { type: 'staff_directory', id: 'centre_rewrap_facts', purpose: 'identity' },
      id: 'key_rewrap_facts',
      createdAt: now,
    })
    await env.DB.prepare(
      `INSERT INTO data_keys
       (id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,kek_version,created_at,retired_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL)`
    ).bind(
      legacy.id, legacy.scope_type, legacy.scope_id, legacy.purpose, legacy.dek_version,
      legacy.wrapped_key_b64, legacy.wrap_nonce_b64, legacy.kek_version, legacy.created_at,
    ).run()
    await env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,version,created_at,updated_at)
       VALUES ('stf_rewrap_facts','lookup_rewrap_facts','{}','{}','owner','pending',1,?,?)`
    ).bind(now, now).run()
    const patch = await rewrapDataKey(v2, legacy, { targetKekVersion: 2 })
    const wrong = [
      { ...patch.where, id: 'key_rewrap_missing' },
      { ...patch.where, scope_type: 'other_scope' },
      { ...patch.where, scope_id: 'centre_other' },
      { ...patch.where, purpose: 'other' },
      { ...patch.where, dek_version: 2 },
      { ...patch.where, wrapped_key_b64: flip(patch.where.wrapped_key_b64) },
      { ...patch.where, wrap_nonce_b64: flip(patch.where.wrap_nonce_b64) },
      { ...patch.where, kek_version: 2 },
    ]
    for (const [index, where] of wrong.entries()) {
      const set = where.kek_version === 2 ? { ...patch.set, kek_version: 3 } : patch.set
      await expect(applyDataKeyRewrap(env.DB, { where, set }, {
        actorStaffId: 'stf_rewrap_facts',
        correlationId,
        occurredAt: now,
        auditId: `aud_rewrap_wrong_${index}`,
      })).rejects.toThrow(/^VERSION_CONFLICT$/)
      expect(await env.DB.prepare('SELECT id FROM audit_events WHERE id=?')
        .bind(`aud_rewrap_wrong_${index}`).first()).toBeNull()
    }
    expect(await env.DB.prepare(
      'SELECT wrapped_key_b64,wrap_nonce_b64,kek_version FROM data_keys WHERE id=?'
    ).bind(legacy.id).first()).toEqual({
      wrapped_key_b64: legacy.wrapped_key_b64,
      wrap_nonce_b64: legacy.wrap_nonce_b64,
      kek_version: 1,
    })

    const occupiedAuditId = 'aud_rewrap_occupied'
    await auditEventStatement(env.DB, {
      id: occupiedAuditId,
      occurredAt: now,
      actorStaffId: 'stf_rewrap_facts',
      action: 'data_key.rewrapped',
      entityType: 'data_key',
      entityId: 'key_other',
      result: 'success',
      correlationId,
      metadata: { oldKekVersion: 1, newKekVersion: 2 },
      reasonEnvelope: null,
    }).run()
    await expect(applyDataKeyRewrap(env.DB, patch, {
      actorStaffId: 'stf_rewrap_facts',
      correlationId,
      occurredAt: now,
      auditId: occupiedAuditId,
    })).rejects.toThrow(/identity_collision/)
    expect((await env.DB.prepare('SELECT kek_version FROM data_keys WHERE id=?').bind(legacy.id).first()).kek_version)
      .toBe(1)
  })
})
