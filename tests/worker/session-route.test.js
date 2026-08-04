import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import {
  authorize,
  CAPABILITIES,
  capabilitiesForActor,
} from '../../worker/identity/policy.js'
import { getSession } from '../../worker/routes/session.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  blindEmailIndex,
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { verifyCsrfToken } from '../../worker/security/csrf.js'
import { NOW_MS } from './fixtures.js'

const now = new Date(NOW_MS).toISOString()
const correlationId = '11111111-1111-4111-8111-111111111111'
const scope = { type: 'staff_directory', id: 'centre_session', purpose: 'identity' }
const config = { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl' }

async function fixture(suffix = 'owner', {
  role = 'owner',
  specialistId = role === 'specialist' ? `sp_${suffix}` : null,
  tamperedDisplay = false,
} = {}) {
  const actorId = `stf_session_${suffix}`
  const subject = `access-session-${suffix}`
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
    id: 'key_session',
    createdAt: now,
  })
  const validDisplayNameEnvelope = JSON.stringify(await encryptForScope(keyring, dataKey, {
    expectedScope: scope,
    recordId: actorId,
    field: 'display_name',
    plaintext: `Julia ${suffix}`,
  }))
  const displayNameEnvelope = tamperedDisplay ? '{}' : validDisplayNameEnvelope
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,specialist_id,version,activated_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,?,3,?,?,?)`
  ).bind(
    actorId,
    await blindEmailIndex(`session-${suffix}@example.test`, keyring),
    '{}',
    displayNameEnvelope,
    role,
    subject,
    specialistId,
    now,
    now,
    now,
  ).run()
  return { keyring, dataKey, scope, actorId, subject, role, specialistId }
}

describe('/api/v1/session route', () => {
  it('revalidates the actor row, decrypts only the display name, and binds exact CSRF expiry', async () => {
    const cryptoContext = await fixture('owner')
    const result = await getSession({
      db: env.DB,
      config,
      principal: { kind: 'human', subject: cryptoContext.subject },
      actor: { id: cryptoContext.actorId, role: 'owner', specialistId: null, version: 3 },
      cryptoContext,
      nowMs: NOW_MS + 999,
    })
    expect(result.data.actor).toEqual({
      id: 'stf_session_owner',
      displayName: 'Julia owner',
      role: 'owner',
      specialistId: null,
      version: 3,
    })
    expect(result.data.capabilities).toEqual([...result.data.capabilities].sort())
    expect(Object.isFrozen(result.data.actor)).toBe(true)
    expect(Object.isFrozen(result.data.capabilities)).toBe(true)
    expect(result.data.environment).toBe('staging')
    expect(result.data.dataMode).toBe('fictional')
    expect(result.data.csrfExpiresAt).toBe(new Date((Math.floor((NOW_MS + 999) / 1000) + 900) * 1000).toISOString())
    await expect(verifyCsrfToken(result.data.csrfToken, {
      subject: cryptoContext.subject,
      origin: config.appOrigin,
      keyring: cryptoContext.keyring,
      nowMs: NOW_MS + 1_000,
    })).resolves.toBe(true)
    await expect(verifyCsrfToken(result.data.csrfToken, {
      subject: 'access-other',
      origin: config.appOrigin,
      keyring: cryptoContext.keyring,
      nowMs: NOW_MS + 1_000,
    })).rejects.toThrow(/^CSRF_INVALID$/)
    expect(JSON.stringify(result)).not.toContain('email')
    expect(JSON.stringify(result)).not.toContain(cryptoContext.subject)
    expect(JSON.stringify(result)).not.toContain('ciphertext')
  })

  it('denies stale actor facts before decrypting', async () => {
    const cryptoContext = await fixture('stale')
    const decrypt = vi.fn()
    await expect(getSession({
      db: env.DB,
      config,
      principal: { kind: 'human', subject: cryptoContext.subject },
      actor: { id: cryptoContext.actorId, role: 'owner', specialistId: 'sp_owner', version: 2 },
      cryptoContext,
      nowMs: NOW_MS,
      decryptForScope: decrypt,
    })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect(decrypt).not.toHaveBeenCalled()
  })

  it.each([
    ['owner', CAPABILITIES],
    ['coordinator', [
      'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
      'client.manage', 'client.operational.read', 'finance.centre.read', 'operations.health.read',
      'payment.manage', 'specialist.directory.read', 'tus.manage',
    ]],
    ['specialist', [
      'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
      'client.manage', 'client.operational.read', 'clinical.read', 'payment.manage',
      'specialist.directory.read', 'tus.manage',
    ]],
  ])('returns the exact sorted %s capability hints', async (role, expected) => {
    const context = await fixture(`role_${role}`, { role })
    const actor = {
      id: context.actorId,
      role,
      specialistId: context.specialistId,
      version: 3,
    }
    const result = await getSession({
      db: env.DB,
      config,
      principal: { kind: 'human', subject: context.subject },
      actor,
      cryptoContext: context,
      nowMs: NOW_MS,
    })
    expect(result.data.capabilities).toEqual([...expected].sort())
    expect(result.data.capabilities).toEqual([...capabilitiesForActor(actor)].sort())
    if (role === 'specialist') {
      expect(result.data.capabilities).toContain('appointment.manage')
      expect(authorize(actor, 'appointment.manage', {
        kind: 'appointment',
        appointmentId: 'apt_other',
        specialistId: 'sp_other',
      }, { nowMs: NOW_MS })).toBe(false)
    }
  })

  it.each(['status', 'subject', 'version'])(
    'revalidates changed %s facts before decrypting',
    async (fact) => {
      const context = await fixture(`changed_${fact}`, { role: 'coordinator' })
      let subject = context.subject
      let version = 3
      if (fact === 'status') {
        await env.DB.prepare(
          "UPDATE staff_users SET status='disabled',disabled_at=?,version=version+1,updated_at=? WHERE id=?"
        ).bind(now, now, context.actorId).run()
        version = 4
      } else if (fact === 'subject') {
        await env.DB.prepare(
          'UPDATE staff_users SET access_subject=?,version=version+1,updated_at=? WHERE id=?'
        ).bind(`${context.subject}-changed`, now, context.actorId).run()
        version = 4
      } else {
        version = 2
      }
      const decrypt = vi.fn()
      await expect(getSession({
        db: env.DB,
        config,
        principal: { kind: 'human', subject },
        actor: {
          id: context.actorId,
          role: 'coordinator',
          specialistId: null,
          version,
        },
        cryptoContext: context,
        nowMs: NOW_MS,
        decryptForScope: decrypt,
      })).rejects.toThrow(/^ACCESS_DENIED$/)
      expect(decrypt).not.toHaveBeenCalled()
    }
  )

  it('loads and decrypts only the exact scope, record, and display-name field', async () => {
    const context = await fixture('exact_crypto')
    const load = vi.fn(async () => context.dataKey)
    const decrypt = vi.fn(async () => 'Exact Name')
    const actor = {
      id: context.actorId, role: 'owner', specialistId: null, version: 3,
    }
    const result = await getSession({
      db: env.DB,
      config,
      principal: { kind: 'human', subject: context.subject },
      actor,
      cryptoContext: context,
      nowMs: NOW_MS,
      loadDataKey: load,
      decryptForScope: decrypt,
    })
    expect(load).toHaveBeenCalledOnce()
    expect(load.mock.calls[0][0]).toBe(env.DB)
    expect(load.mock.calls[0][1].expectedScope).toEqual(scope)
    expect(load.mock.calls[0][1].envelope).toEqual(expect.any(Object))
    expect(decrypt).toHaveBeenCalledOnce()
    expect(decrypt.mock.calls[0][0]).toBe(context.keyring)
    expect(decrypt.mock.calls[0][1]).toBe(context.dataKey)
    expect(decrypt.mock.calls[0][2]).toMatchObject({
      expectedScope: scope,
      recordId: context.actorId,
      field: 'display_name',
    })
    expect(decrypt.mock.calls[0][2].envelope).toEqual(expect.any(Object))
    expect(result.data.actor.displayName).toBe('Exact Name')
  })

  it('maps wrong scope and tampered display envelopes to crypto failure', async () => {
    const wrongScope = await fixture('wrong_scope')
    await expect(getSession({
      db: env.DB,
      config,
      principal: { kind: 'human', subject: wrongScope.subject },
      actor: { id: wrongScope.actorId, role: 'owner', specialistId: null, version: 3 },
      cryptoContext: { ...wrongScope, scope: { ...scope, id: 'centre_wrong' } },
      nowMs: NOW_MS,
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)

    const tampered = await fixture('tampered', { tamperedDisplay: true })
    await expect(getSession({
      db: env.DB,
      config,
      principal: { kind: 'human', subject: tampered.subject },
      actor: { id: tampered.actorId, role: 'owner', specialistId: null, version: 3 },
      cryptoContext: tampered,
      nowMs: NOW_MS,
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
  })

  it('rejects the same display envelope under a wrong field or record id', async () => {
    const context = await fixture('aad_mismatch')
    const row = await env.DB.prepare(
      'SELECT display_name_envelope FROM staff_users WHERE id=?'
    ).bind(context.actorId).first()
    const envelope = JSON.parse(row.display_name_envelope)
    await expect(decryptForScope(context.keyring, context.dataKey, {
      expectedScope: scope,
      recordId: 'stf_other',
      field: 'display_name',
      envelope,
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
    await expect(decryptForScope(context.keyring, context.dataKey, {
      expectedScope: scope,
      recordId: context.actorId,
      field: 'email',
      envelope,
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
  })

  it('binds CSRF to origin and exact second-boundary expiry and sets no cookie', async () => {
    const context = await fixture('csrf_boundary')
    const deps = {
      config,
      db: env.DB,
      now: () => NOW_MS + 999,
      cryptoContext: context,
      safeLog: vi.fn(),
      resolveAccessPrincipal: vi.fn(async () => ({
        kind: 'human',
        subject: context.subject,
        normalizedEmail: 'csrf-boundary@example.test',
      })),
      resolveActor: vi.fn(async () => ({
        id: context.actorId,
        role: 'owner',
        specialistId: null,
        version: 3,
      })),
    }
    const response = await createApp(deps).request('/api/v1/session')
    const result = await response.json()
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(result.data.csrfExpiresAt).toBe(
      new Date((Math.floor((NOW_MS + 999) / 1000) + 900) * 1000).toISOString()
    )
    await expect(verifyCsrfToken(result.data.csrfToken, {
      subject: context.subject,
      origin: 'https://other.bearwithme.pl',
      keyring: context.keyring,
      nowMs: NOW_MS + 1_000,
    })).rejects.toThrow(/^CSRF_INVALID$/)
    await expect(verifyCsrfToken(result.data.csrfToken, {
      subject: context.subject,
      origin: config.appOrigin,
      keyring: context.keyring,
      nowMs: (Math.floor((NOW_MS + 999) / 1000) + 900) * 1000,
    })).rejects.toThrow(/^CSRF_EXPIRED$/)
  })
})
