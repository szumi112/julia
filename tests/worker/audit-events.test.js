import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { auditDescriptorFor, auditEventStatement } from '../../worker/audit/events.js'

const event = Object.freeze({
  id: 'aud_fixture', occurredAt: '2027-01-15T10:00:00.000Z', actorStaffId: null,
  action: 'identity.reindex', entityType: 'staff_user', entityId: 'stf_fixture', result: 'success',
  correlationId: 'correlation_fixture', metadata: { version: 2 }, reasonEnvelope: null,
})

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

  it('rejects inherited, extra, plaintext, wildcard, and malformed event input', () => {
    const inherited = Object.create({ action: 'identity.reindex' })
    Object.assign(inherited, { ...event })
    delete inherited.action
    const invalid = [
      inherited, { ...event, email: 'staff@example.test' }, { ...event, action: 'identity.any' },
      { ...event, metadata: { email: 1 } }, { ...event, metadata: { version: 0 } },
      { ...event, reasonEnvelope: 'plaintext reason' }, { ...event, occurredAt: 'bad' },
      { ...event, correlationId: ' ' },
    ]
    for (const value of invalid) expect(() => auditEventStatement(env.DB, value)).toThrow(/^AUDIT_EVENT_INVALID$/)
  })
})
