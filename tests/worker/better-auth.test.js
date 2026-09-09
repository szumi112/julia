import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBetterAuth, resolveBetterAuthPrincipal } from '../../worker/identity/better-auth.js'
import { createApp } from '../../worker/app.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { blindEmailIndex, encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { loadConfig } from '../../worker/config.js'
import { completeCoreDirectoryStageA, applyCoreDirectoryStageB, applyFinanceStageC, applySpecialistProfilesStageD, applyWorkbookRegistryStageE, applyAuthenticationStageF } from './apply-migrations.js'

const origin = 'http://127.0.0.1:5174'
const scope = { type: 'staff_directory', id: 'centre_1', purpose: 'identity' }
const secret = 'fictional-better-auth-integration-test-secret-2026'
const bindings = { ...env, BETTER_AUTH_SECRET: secret }
const config = loadConfig(bindings)
const messages = []
let auth
const request = (path, body, cookie) => new Request(`${origin}/api/auth${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), 'cf-connecting-ip': '192.0.2.1' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const cookies = (response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
async function person(suffix) {
  const email = `${suffix}@example.test`
  const keyring = await createKeyring(bindings, config)
  const now = new Date().toISOString()
  const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, { id: 'key_better_auth', createdAt: now })
  const encrypt = async (field, value) => JSON.stringify(await encryptForScope(keyring, dataKey, { expectedScope: scope, recordId: `stf_${suffix}`, field, plaintext: value }))
  await env.DB.prepare(`INSERT INTO staff_users (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,version,activated_at,created_at,updated_at) VALUES (?,?,?,?,'coordinator','active',?,1,?,?,?)`).bind(`stf_${suffix}`, await blindEmailIndex(email, keyring), await encrypt('email', email), await encrypt('display_name', 'Osoba Testowa'), `legacy:${suffix}`, now, now, now).run()
  return email
}
async function signIn(email) {
  const sent = await auth.handler(request('/email-otp/send-verification-otp', { email, type: 'sign-in' }))
  expect(sent.status).toBe(200)
  const message = messages.findLast(message => message.recipient === email)
  expect(message?.otp).toMatch(/^\d{6}$/)
  const response = await auth.handler(request('/sign-in/email-otp', { email, otp: message.otp }))
  expect(response.status).toBe(200)
  return { response, cookie: cookies(response), otp: message.otp }
}

describe('application authentication', () => {
  beforeEach(async () => { await env.DB.prepare('DELETE FROM auth_rate_limit').run() })
  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await applyFinanceStageC()
    await applySpecialistProfilesStageD()
    await applyWorkbookRegistryStageE()
    await applyAuthenticationStageF()
    auth = createBetterAuth({ env: bindings, config, sendEmail: async message => { messages.push(message) } })
  })
  it('does not send codes or create accounts for people without access', async () => {
    const response = await auth.handler(request('/email-otp/send-verification-otp', { email: 'outsider@example.test', type: 'sign-in' }))
    expect(response.status).toBe(200)
    expect(messages).toHaveLength(0)
    expect((await env.DB.prepare('SELECT count(*) AS n FROM auth_user').first()).n).toBe(0)
  })
  it('binds verified email to existing staff without replacing the Access identity', async () => {
    const email = await person('login_verified')
    const { cookie, otp } = await signIn(email)
    const principal = await resolveBetterAuthPrincipal(request('/get-session', undefined, cookie), { env: bindings, config, auth })
    expect(principal.subject).toBe('legacy:login_verified')
    expect(principal.normalizedEmail).toBe(email)
    expect(principal.expiresAt - principal.issuedAt).toBe(8 * 60 * 60)
    const binding = await env.DB.prepare('SELECT staff_id FROM staff_auth_identities').first()
    expect(binding.staff_id).toBe('stf_login_verified')
    const replay = await auth.handler(request('/sign-in/email-otp', { email, otp }))
    expect(replay.status).toBe(400)
  })
  it('rejects a disabled person even with an existing valid authentication session', async () => {
    const email = await person('login_disabled')
    const { cookie } = await signIn(email)
    await resolveBetterAuthPrincipal(request('/get-session', undefined, cookie), { env: bindings, config, auth })
    await env.DB.prepare("UPDATE staff_users SET status='disabled',disabled_at=?,version=version+1 WHERE id=?").bind(new Date().toISOString(), 'stf_login_disabled').run()
    await expect(resolveBetterAuthPrincipal(request('/get-session', undefined, cookie), { env: bindings, config, auth })).rejects.toThrow('ACCESS_DENIED')
  })
  it('keeps application APIs protected after removing the edge login', async () => {
    const app = createApp()
    const response = await app.fetch(new Request(`${origin}/api/v1/session`), bindings)
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('AUTH_REQUIRED')
  })
  it('rejects public password registration', async () => {
    const response = await auth.handler(request('/sign-up/email', { email: 'outsider@example.test', password: 'correct-horse-battery', name: 'Outsider' }))
    expect(response.status).toBe(404)
  })
  it('sets a first password only with CSRF, signs in, resets it and revokes old sessions', async () => {
    const email = await person('login_password')
    const { cookie } = await signIn(email)
    const app = createApp()
    const sessionResponse = await app.fetch(new Request(`${origin}/api/v1/session`, { headers: { Cookie: cookie } }), bindings)
    expect(sessionResponse.status).toBe(200)
    const { data: session } = await sessionResponse.json()
    const passwordRequest = csrf => new Request(`${origin}/api/v1/account/password`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify({ newPassword: 'first-password-test-2026' }),
    })
    expect((await app.fetch(passwordRequest(), bindings)).status).toBe(403)
    expect((await app.fetch(passwordRequest(session.csrfToken), bindings)).status).toBe(200)
    const login = await auth.handler(request('/sign-in/email', { email, password: 'first-password-test-2026', rememberMe: true }))
    expect(login.status).toBe(200)
    expect(login.headers.getSetCookie().find(cookie => cookie.startsWith('bwm-auth.session_token='))).toContain('Max-Age=28800')
    const stored = await env.DB.prepare("SELECT password FROM auth_account WHERE providerId='credential'").first()
    expect(stored.password).not.toContain('first-password-test-2026')
    const reset = await auth.handler(request('/request-password-reset', { email, redirectTo: `${origin}/#/reset-password` }))
    expect(reset.status).toBe(200)
    const url = messages.findLast(message => message.recipient === email && message.purpose === 'reset').url
    const redirected = await auth.handler(new Request(url))
    expect(redirected.status).toBe(302)
    const token = new URL(redirected.headers.get('location')).searchParams.get('token')
    expect(token).toBeTruthy()
    const changed = await auth.handler(request('/reset-password', { token, newPassword: 'replacement-password-test-2026' }))
    expect(changed.status).toBe(200)
    await expect(resolveBetterAuthPrincipal(request('/get-session', undefined, cookie), { env: bindings, config, auth })).rejects.toThrow('AUTH_REQUIRED')
    expect((await auth.handler(request('/reset-password', { token, newPassword: 'another-password-test-2026' }))).status).toBe(400)
    const replacement = await auth.handler(request('/sign-in/email', { email, password: 'replacement-password-test-2026', rememberMe: false }))
    expect(replacement.status).toBe(200)
    expect(replacement.headers.getSetCookie().find(cookie => cookie.startsWith('bwm-auth.session_token='))).not.toContain('Max-Age=')
    const temporary = await resolveBetterAuthPrincipal(request('/get-session', undefined, cookies(replacement)), { env: bindings, config, auth })
    expect(temporary.expiresAt - temporary.issuedAt).toBe(8 * 60 * 60)
    const logout = await app.fetch(request('/sign-out', {}, cookies(replacement)), bindings)
    expect(logout.status).toBe(200)
    await expect(resolveBetterAuthPrincipal(request('/get-session', undefined, cookies(replacement)), { env: bindings, config, auth })).rejects.toThrow('AUTH_REQUIRED')
  })
  it('rejects cross-origin login and unavailable social login', async () => {
    const app = createApp()
    const crossOrigin = request('/sign-in/email', { email: 'login_password@example.test', password: 'replacement-password-test-2026' })
    crossOrigin.headers.set('Origin', 'https://untrusted.example')
    expect((await app.fetch(crossOrigin, bindings)).status).toBe(403)
    const callback = await app.fetch(new Request(`${origin}/api/auth/callback/google?code=invalid`), bindings)
    expect(callback.status).toBe(404)
    expect(callback.headers.getSetCookie().some(cookie => cookie.includes('session_token='))).toBe(false)
  })
})
