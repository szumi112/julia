import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { getSession } from '../../worker/routes/session.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { blindEmailIndex, encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { verifyCsrfToken } from '../../worker/security/csrf.js'
import { NOW_MS } from './fixtures.js'

const now = new Date(NOW_MS).toISOString()
const correlationId = '11111111-1111-4111-8111-111111111111'
const scope = { type: 'staff_directory', id: 'centre_session', purpose: 'identity' }
const config = { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl' }

async function fixture(suffix = 'owner') {
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
  const displayNameEnvelope = JSON.stringify(await encryptForScope(keyring, dataKey, {
    expectedScope: scope,
    recordId: actorId,
    field: 'display_name',
    plaintext: 'Julia Testowa',
  }))
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,specialist_id,version,activated_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,?,3,?,?,?)`
  ).bind(
    actorId,
    await blindEmailIndex(`session-${suffix}@example.test`, keyring),
    '{}',
    displayNameEnvelope,
    'owner',
    subject,
    'sp_owner',
    now,
    now,
    now,
  ).run()
  return { keyring, dataKey, scope, actorId, subject }
}

describe('/api/v1/session route', () => {
  it('revalidates the actor row, decrypts only the display name, and binds exact CSRF expiry', async () => {
    const cryptoContext = await fixture('owner')
    const result = await getSession({
      db: env.DB,
      config,
      principal: { kind: 'human', subject: cryptoContext.subject },
      actor: { id: cryptoContext.actorId, role: 'owner', specialistId: 'sp_owner', version: 3 },
      cryptoContext,
      nowMs: NOW_MS + 999,
    })
    expect(result.data.actor).toEqual({
      id: 'stf_session_owner',
      displayName: 'Julia Testowa',
      role: 'owner',
      specialistId: 'sp_owner',
    })
    expect(result.data.capabilities).toEqual([...result.data.capabilities].sort())
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
})
