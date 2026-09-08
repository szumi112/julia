import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../worker/app.js'
import { loadConfig } from '../../worker/config.js'
import { createBetterAuth } from '../../worker/identity/better-auth.js'
import { inviteStaff } from '../../worker/identity/invitations.js'
import { resolveCurrentAuthorityActor } from '../../worker/identity/staff.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { blindEmailIndex, encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import {
  completeCoreDirectoryStageA,
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  applyAuthenticationStageF,
} from './apply-migrations.js'

const origin = 'http://127.0.0.1:5174'
const scope = { type: 'staff_directory', id: 'centre_1', purpose: 'identity' }
const bindings = { ...env, BETTER_AUTH_SECRET: 'fictional-invitation-auth-integration-secret-2026' }
const config = loadConfig(bindings)
const messages = []
let auth

const authRequest = (path, body) => new Request(`${origin}/api/auth${path}`, {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json', 'cf-connecting-ip': '192.0.2.2' },
  body: JSON.stringify(body),
})

async function invitation(suffix, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString()
  const ownerId = `stf_inviting_${suffix}`
  const ownerEmail = `inviting-${suffix}@example.test`
  const email = `invited-${suffix}@example.test`
  const keyring = await createKeyring(bindings, config)
  const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
    id: 'key_native_invitation', createdAt: now,
  })
  const encrypted = async (field, value) => JSON.stringify(await encryptForScope(keyring, dataKey, {
    expectedScope: scope, recordId: ownerId, field, plaintext: value,
  }))
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     version,activated_at,created_at,updated_at)
    VALUES (?,?,?,?,'owner','active',?,1,?,?,?)`)
    .bind(ownerId, await blindEmailIndex(ownerEmail, keyring), await encrypted('email', ownerEmail),
      await encrypted('display_name', 'Osoba Zapraszająca'), `legacy:${suffix}`, now, now, now).run()
  const actor = await resolveCurrentAuthorityActor(env.DB, {
    id: ownerId, role: 'owner', specialist_id: null, version: 1,
  })
  const result = await inviteStaff({
    db: env.DB,
    cryptoContext: { keyring, dataKey, scope },
    actor,
    input: { displayName: 'Zaproszona Specjalistka', email, role: 'specialist' },
    idempotencyKey: `native-invite-${suffix}`,
    correlationId: '99999999-9999-4999-8999-999999999999',
    nowMs,
    appEnv: config.appEnv,
    dataMode: 'fictional',
  })
  return { ...result.data, email }
}

describe('native authentication invitation activation', () => {
  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await applyFinanceStageC()
    await applySpecialistProfilesStageD()
    await applyWorkbookRegistryStageE()
    await applyAuthenticationStageF()
    auth = createBetterAuth({ env: bindings, config, sendEmail: async message => { messages.push(message) } })
  })
  beforeEach(async () => {
    messages.length = 0
    await env.DB.prepare('DELETE FROM auth_rate_limit').run()
  })

  it('activates an invited specialist through OTP and the real session API without changing their assigned identity', async () => {
    const invited = await invitation('activation')
    expect(invited.invitation.status).toBe('pending')
    const send = await auth.handler(authRequest('/email-otp/send-verification-otp', {
      email: invited.email, type: 'sign-in',
    }))
    expect(send.status).toBe(200)
    const message = messages.find(message => message.recipient === invited.email)
    expect(message?.otp).toMatch(/^\d{6}$/)
    const login = await auth.handler(authRequest('/sign-in/email-otp', {
      email: invited.email, otp: message.otp,
    }))
    expect(login.status).toBe(200)
    expect(await env.DB.prepare('SELECT status FROM staff_users WHERE id=?')
      .bind(invited.staff.id).first()).toEqual({ status: 'pending' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const app = createApp()
    const response = await app.fetch(new Request(`${origin}/api/v1/session`, {
      headers: { Cookie: cookie },
    }), bindings)
    expect(response.status).toBe(200)
    const { data } = await response.json()
    expect(data.actor).toMatchObject({
      id: invited.staff.id,
      role: 'specialist',
      specialistId: invited.staff.specialistId,
      displayName: 'Zaproszona Specjalistka',
      version: 2,
    })
    expect(data.csrfToken).toBeTruthy()
    const staff = await env.DB.prepare('SELECT status,access_subject FROM staff_users WHERE id=?')
      .bind(invited.staff.id).first()
    expect(staff.status).toBe('active')
    expect(staff.access_subject).toMatch(/^ba:/)
    expect(await env.DB.prepare('SELECT staff_user_id,status FROM specialists WHERE id=?')
      .bind(invited.staff.specialistId).first()).toEqual({ staff_user_id: invited.staff.id, status: 'active' })
    expect(await env.DB.prepare('SELECT status FROM staff_invitations WHERE id=?')
      .bind(invited.invitation.id).first()).toEqual({ status: 'activated' })
    const second = await app.fetch(new Request(`${origin}/api/v1/session`, {
      headers: { Cookie: cookie },
    }), bindings)
    expect(second.status).toBe(200)
    expect((await second.json()).data.actor).toEqual(data.actor)
  })

  it('does not issue OTP or create an authentication account for an expired invitation', async () => {
    const invited = await invitation('expired', Date.now() - 8 * 24 * 60 * 60 * 1000)
    const send = await auth.handler(authRequest('/email-otp/send-verification-otp', {
      email: invited.email, type: 'sign-in',
    }))
    expect(send.status).toBe(200)
    expect(await send.json()).toEqual({ success: true })
    expect(messages).toHaveLength(0)
    const login = await auth.handler(authRequest('/sign-in/email-otp', {
      email: invited.email, otp: '123456',
    }))
    expect(login.status).toBe(403)
    expect(await env.DB.prepare('SELECT id FROM auth_user WHERE email=?').bind(invited.email).first()).toBe(null)
    expect(await env.DB.prepare('SELECT status FROM staff_users WHERE id=?')
      .bind(invited.staff.id).first()).toEqual({ status: 'pending' })
  })
})
