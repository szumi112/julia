import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { auditDescriptorFor, auditEventStatement, encryptAuditReason } from '../../worker/audit/events.js'
import { decodeBase64Url, encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { decryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'

const event = Object.freeze({
  id: 'aud_fixture', occurredAt: '2027-01-15T10:00:00.000Z', actorStaffId: null,
  action: 'identity.reindex', entityType: 'staff_user', entityId: 'stf_fixture', result: 'success',
  correlationId: 'correlation_fixture', metadata: { version: 2 }, reasonEnvelope: null,
})

async function reasonFixture(auditEventId = 'aud_authorization_denied') {
  const keyring = await createKeyring({
    BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  }, { activeDataKekVersion: 1, activeLookupKeyVersion: 1 })
  const scope = { type: 'staff_directory', id: `centre_${auditEventId}`, purpose: 'identity' }
  const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
    id: `key_${auditEventId}`, createdAt: event.occurredAt,
  })
  const reason = await encryptAuditReason({
    keyring, dataKey, expectedScope: scope, auditEventId, plaintext: 'policy marker',
  })
  return { keyring, scope, dataKey, reason }
}

describe('shared audit statement constructor', () => {
  it('returns a tagged prepared statement with a frozen non-sensitive descriptor', async () => {
    const statement = auditEventStatement(env.DB, event)
    expect(auditDescriptorFor(statement)).toEqual({
      id: 'aud_fixture', action: 'identity.reindex', entityType: 'staff_user', entityId: 'stf_fixture',
      result: 'success', actorStaffId: null, correlationId: 'correlation_fixture',
    })
    expect(Object.isFrozen(auditDescriptorFor(statement))).toBe(true)
    await statement.run()
    expect(await env.DB.prepare("SELECT reason_envelope,metadata_json FROM audit_events WHERE id='aud_fixture'").first())
      .toEqual({ reason_envelope: null, metadata_json: '{"version":2}' })
  })

  it.each([
    ['identity.activation', 'staff_user', 'success', { invitationVersion: 2, staffVersion: 3 }],
    ['identity.denied', 'staff_user', 'denied', { version: 2 }],
    ['identity.reindex', 'staff_user', 'success', { version: 3 }],
    ['identity.reindex', 'staff_invitation', 'success', { version: 3 }],
    ['data_key.rewrapped', 'data_key', 'success', { newKekVersion: 2, oldKekVersion: 1 }],
  ])('accepts the exact null-reason schema for %s/%s', async (action, entityType, result, metadata) => {
    const id = `aud_${action.replaceAll('.', '_')}_${entityType}`
    const statement = auditEventStatement(env.DB, {
      ...event, id, action, entityType, entityId: entityType === 'data_key' ? 'key_fixture' : 'stf_schema',
      result, metadata,
    })
    await statement.run()
    expect((await env.DB.prepare('SELECT metadata_json FROM audit_events WHERE id=?').bind(id).first()).metadata_json)
      .toBe(JSON.stringify(Object.fromEntries(Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right)))))
  })

  it('accepts authorization.denied only with its exact encrypted reason policy', async () => {
    const id = 'aud_authorization_denied'
    const { reason } = await reasonFixture(id)
    const statement = auditEventStatement(env.DB, {
      ...event, id, action: 'authorization.denied', entityType: 'staff_user', entityId: 'stf_denied',
      result: 'denied', metadata: { version: 2 }, reasonEnvelope: reason,
    })
    await statement.run()
    const raw = await env.DB.prepare('SELECT reason_envelope,metadata_json FROM audit_events WHERE id=?').bind(id).first()
    expect(raw).toEqual({ reason_envelope: reason, metadata_json: '{"version":2}' })
    expect(JSON.stringify(raw)).not.toContain('policy marker')
  })

  it.each([
    ['identity.activation', 'wrong_entity', 'success', { staffVersion: 2, invitationVersion: 2 }],
    ['identity.denied', 'staff_invitation', 'denied', { version: 2 }],
    ['identity.reindex', 'data_key', 'success', { version: 2 }],
    ['data_key.rewrapped', 'staff_user', 'success', { oldKekVersion: 1, newKekVersion: 2 }],
  ])('rejects the wrong entity for %s', (action, entityType, result, metadata) => {
    expect(() => auditEventStatement(env.DB, {
      ...event, action, entityType, result, metadata, reasonEnvelope: null,
    })).toThrow(/^AUDIT_EVENT_INVALID$/)
  })

  it.each([
    ['identity.activation', 'staff_user', 'denied', { staffVersion: 2, invitationVersion: 2 }],
    ['identity.denied', 'staff_user', 'success', { version: 2 }],
    ['identity.reindex', 'staff_user', 'failure', { version: 2 }],
    ['data_key.rewrapped', 'data_key', 'denied', { oldKekVersion: 1, newKekVersion: 2 }],
  ])('rejects the wrong result for %s', (action, entityType, result, metadata) => {
    expect(() => auditEventStatement(env.DB, {
      ...event, action, entityType, result, metadata, reasonEnvelope: null,
    })).toThrow(/^AUDIT_EVENT_INVALID$/)
  })

  it('rejects inherited, extra, plaintext, wildcard, and malformed event input', () => {
    const inherited = Object.create({ action: 'identity.reindex' })
    Object.assign(inherited, { ...event })
    delete inherited.action
    const inheritedMetadata = Object.create({ version: 2 })
    const invalid = [
      inherited, { ...event, email: 'staff@example.test' }, { ...event, action: 'identity.any' },
      { ...event, metadata: inheritedMetadata }, { ...event, metadata: { email: 1 } },
      { ...event, metadata: { version: 2, extra: 1 } }, { ...event, metadata: { version: 0 } },
      { ...event, metadata: { version: 1.5 } }, { ...event, metadata: { version: Number.MAX_SAFE_INTEGER + 1 } },
      { ...event, reasonEnvelope: 'plaintext reason' }, { ...event, occurredAt: 'bad' },
      { ...event, correlationId: ' ' },
      {
        ...event, action: 'identity.activation',
        metadata: { staffVersion: 2, invitationVersion: 2, accessSubject: 1 },
      },
      {
        ...event, action: 'data_key.rewrapped', entityType: 'data_key', entityId: 'key_fixture',
        metadata: { version: 2 },
      },
    ]
    for (const value of invalid) expect(() => auditEventStatement(env.DB, value)).toThrow(/^AUDIT_EVENT_INVALID$/)
  })

  it('requires exact positive rewrap metadata and serializes keys canonically', async () => {
    const statement = auditEventStatement(env.DB, {
      ...event, id: 'aud_rewrap_order', action: 'data_key.rewrapped', entityType: 'data_key',
      entityId: 'key_rewrap_order', metadata: { oldKekVersion: 1, newKekVersion: 2 },
    })
    await statement.run()
    expect((await env.DB.prepare("SELECT metadata_json FROM audit_events WHERE id='aud_rewrap_order'").first()).metadata_json)
      .toBe('{"newKekVersion":2,"oldKekVersion":1}')
    for (const metadata of [
      { oldKekVersion: 0, newKekVersion: 2 },
      { oldKekVersion: 1, newKekVersion: -1 },
      { oldKekVersion: 1, newKekVersion: 2.5 },
      { oldKekVersion: 1, newKekVersion: '2' },
      { oldKekVersion: 1, newKekVersion: 2, version: 2 },
    ]) expect(() => auditEventStatement(env.DB, {
      ...event, action: 'data_key.rewrapped', entityType: 'data_key', entityId: 'key_rewrap_invalid', metadata,
    })).toThrow(/^AUDIT_EVENT_INVALID$/)
  })

  it('rejects non-null reasons for identity and rewrap actions and requires one for authorization denial', async () => {
    const { reason } = await reasonFixture('aud_reason_policy')
    const nullReasonEvents = [
      { action: 'identity.activation', entityType: 'staff_user', metadata: { staffVersion: 2, invitationVersion: 2 } },
      { action: 'identity.denied', entityType: 'staff_user', result: 'denied', metadata: { version: 2 } },
      { action: 'identity.reindex', entityType: 'staff_invitation', metadata: { version: 2 } },
      { action: 'data_key.rewrapped', entityType: 'data_key', metadata: { oldKekVersion: 1, newKekVersion: 2 } },
    ]
    for (const value of nullReasonEvents) expect(() => auditEventStatement(env.DB, {
      ...event, ...value, result: value.result ?? 'success', reasonEnvelope: reason,
    })).toThrow(/^AUDIT_EVENT_INVALID$/)
    expect(() => auditEventStatement(env.DB, {
      ...event, action: 'authorization.denied', entityType: 'staff_user', result: 'denied',
      metadata: { version: 2 }, reasonEnvelope: null,
    })).toThrow(/^AUDIT_EVENT_INVALID$/)
    for (const value of [
      { entityType: 'data_key', result: 'denied' },
      { entityType: 'staff_user', result: 'success' },
    ]) expect(() => auditEventStatement(env.DB, {
      ...event, ...value, action: 'authorization.denied',
      metadata: { version: 2 }, reasonEnvelope: reason,
    })).toThrow(/^AUDIT_EVENT_INVALID$/)
  })

  it('exact-validates reason input and enforces nonempty bounded plaintext', async () => {
    for (const input of [
      { auditEventId: 'aud_reason', plaintext: '' },
      { auditEventId: 'aud_reason', plaintext: 'x'.repeat(2049) },
      { auditEventId: 'aud_reason', plaintext: 'reason', extra: true },
    ]) await expect(encryptAuditReason(input)).rejects.toThrow(/^AUDIT_EVENT_INVALID$/)
  })

  it('creates a canonical scoped envelope and rejects wrong-scope and tampered use', async () => {
    const id = 'aud_reason_envelope'
    const { keyring, dataKey, scope, reason } = await reasonFixture(id)
    const parsed = JSON.parse(reason)
    expect(Object.keys(parsed)).toEqual(['format', 'algorithm', 'dataKeyId', 'dataKeyVersion', 'nonce', 'ciphertext'])
    expect(decodeBase64Url(parsed.nonce)).toHaveLength(12)
    expect(decodeBase64Url(parsed.ciphertext).byteLength).toBeGreaterThanOrEqual(16)
    await expect(decryptForScope(keyring, dataKey, {
      expectedScope: scope, recordId: id, field: 'reason', envelope: parsed,
    })).resolves.toBe('policy marker')
    await expect(encryptAuditReason({
      keyring, dataKey, expectedScope: { ...scope, id: 'wrong_scope' },
      auditEventId: 'aud_wrong_scope', plaintext: 'policy marker',
    })).rejects.toThrow()
    const tampered = { ...parsed, ciphertext: encodeBase64Url(new Uint8Array(decodeBase64Url(parsed.ciphertext).byteLength)) }
    await expect(decryptForScope(keyring, dataKey, {
      expectedScope: scope, recordId: id, field: 'reason', envelope: tampered,
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
  })

  it('rejects malformed serialized envelopes and clears a decoded nonce when ciphertext decoding fails', () => {
    const nonce = encodeBase64Url(new Uint8Array(12))
    const ciphertext = encodeBase64Url(new Uint8Array(16))
    const base = { format: 1, algorithm: 'A256GCM', dataKeyId: 'key_reason', dataKeyVersion: 1, nonce, ciphertext }
    for (const envelope of [
      { ...base, nonce: `${nonce}=` },
      { ...base, nonce: encodeBase64Url(new Uint8Array(11)) },
      { ...base, ciphertext: encodeBase64Url(new Uint8Array(15)) },
      { ...base, extra: true },
    ]) expect(() => auditEventStatement(env.DB, {
      ...event, action: 'authorization.denied', result: 'denied',
      metadata: { version: 2 }, reasonEnvelope: JSON.stringify(envelope),
    })).toThrow(/^AUDIT_EVENT_INVALID$/)

    const cleared = []
    const fill = Uint8Array.prototype.fill
    const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (...args) {
      const result = fill.apply(this, args)
      if (this.byteLength === 12 && args[0] === 0) cleared.push([...this])
      return result
    })
    try {
      expect(() => auditEventStatement(env.DB, {
        ...event, action: 'authorization.denied', result: 'denied', metadata: { version: 2 },
        reasonEnvelope: JSON.stringify({ ...base, ciphertext: '%' }),
      })).toThrow(/^AUDIT_EVENT_INVALID$/)
      expect(cleared).toContainEqual(new Array(12).fill(0))
    } finally {
      spy.mockRestore()
    }
  })
})
