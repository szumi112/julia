import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { applyDataKeyRewrap } from '../../worker/security/data-key-rewrap.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { createWrappedDataKey, rewrapDataKey } from '../../worker/security/envelope.js'

const now = '2027-01-15T08:00:00.000Z'
const correlationId = '11111111-1111-4111-8111-111111111111'

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
})
