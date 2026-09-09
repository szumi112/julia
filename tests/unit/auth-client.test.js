import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AuthRequestError,
  authStrategyFor,
  createAuthClient,
  passwordValidationError,
  resetTokenFromLocation,
} from '../../src/auth-client.js'

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  headers: { 'content-type': 'application/json' },
})

test('accepts Better Auth reset query tokens only beside the reset-password hash route', () => {
  assert.equal(resetTokenFromLocation('?token=abc-123_X', '#/reset-password'), 'abc-123_X')
  assert.equal(resetTokenFromLocation('?token=abc-123_X', '#/settings'), null)
  assert.equal(resetTokenFromLocation('', '#/reset-password'), null)
  assert.equal(resetTokenFromLocation('?token=%0Asecret', '#/reset-password'), null)
})

test('uses the panel login only in development and staging', () => {
  assert.equal(authStrategyFor('app'), 'better-auth')
  assert.equal(authStrategyFor('development'), 'better-auth')
  assert.equal(authStrategyFor('staging'), 'better-auth')
  assert.equal(authStrategyFor('production'), 'cloudflare-access')
  assert.equal(authStrategyFor('demo'), 'demo')
})

test('sends password and OTP sign-ins with same-origin credentials', async () => {
  const requests = []
  const client = createAuthClient(async (url, init) => {
    requests.push({ url, init })
    return jsonResponse({ ok: true })
  })

  await client.signInPassword(' Anna@Example.test ', 'sekretne-haslo', false)
  await client.sendSignInOtp(' Anna@Example.test ')
  await client.signInOtp(' Anna@Example.test ', '123456')

  assert.deepEqual(requests.map(({ url, init }) => ({
    url,
    credentials: init.credentials,
    method: init.method,
    body: JSON.parse(init.body),
  })), [
    { url: '/api/auth/sign-in/email', credentials: 'same-origin', method: 'POST', body: { email: 'anna@example.test', password: 'sekretne-haslo', rememberMe: false } },
    { url: '/api/auth/email-otp/send-verification-otp', credentials: 'same-origin', method: 'POST', body: { email: 'anna@example.test', type: 'sign-in' } },
    { url: '/api/auth/sign-in/email-otp', credentials: 'same-origin', method: 'POST', body: { email: 'anna@example.test', otp: '123456' } },
  ])
})

test('uses Better Auth reset and account-list contracts', async () => {
  const requests = []
  const client = createAuthClient(async (url, init = {}) => {
    requests.push({ url, init })
    return jsonResponse(url.endsWith('/list-accounts') ? [] : { ok: true })
  })

  await client.requestPasswordReset('ola@example.test', 'https://panel.example.test/#/reset-password')
  await client.resetPassword('reset-token', 'bardzo-dlugie-haslo')
  await client.listAccounts()

  assert.deepEqual(requests.map(({ url, init }) => [url, init.method || 'GET', init.body ? JSON.parse(init.body) : null]), [
    ['/api/auth/request-password-reset', 'POST', { email: 'ola@example.test', redirectTo: 'https://panel.example.test/#/reset-password' }],
    ['/api/auth/reset-password', 'POST', { token: 'reset-token', newPassword: 'bardzo-dlugie-haslo' }],
    ['/api/auth/list-accounts', 'GET', null],
  ])
})

test('sends first password through the application CSRF boundary', async () => {
  let request
  const client = createAuthClient(async (url, init) => {
    request = { url, init }
    return jsonResponse({ success: true })
  })

  await client.setFirstPassword('bardzo-dlugie-haslo', 'csrf-token')

  assert.equal(request.url, '/api/v1/account/password')
  assert.equal(request.init.headers['X-CSRF-Token'], 'csrf-token')
  assert.deepEqual(JSON.parse(request.init.body), { newPassword: 'bardzo-dlugie-haslo' })
})

test('sign-out is a JSON mutation and application envelopes preserve their error code', async () => {
  const requests = []
  const client = createAuthClient(async (url, init) => {
    requests.push({ url, init })
    if (url.endsWith('/account/password')) return jsonResponse({ error: { code: 'REAUTH_REQUIRED' } }, { status: 401 })
    return jsonResponse({ success: true })
  })

  await client.signOut()
  assert.deepEqual(JSON.parse(requests[0].init.body), {})
  await assert.rejects(client.setFirstPassword('bardzo-dlugie-haslo', 'csrf'), { code: 'REAUTH_REQUIRED' })
})

test('exposes safe server errors and validates password boundaries', async () => {
  const client = createAuthClient(async () => jsonResponse({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'details' }, { status: 401 }))
  await assert.rejects(client.signInPassword('a@example.test', 'wrong-password', true), (error) => {
    assert.equal(error instanceof AuthRequestError, true)
    assert.equal(error.status, 401)
    assert.equal(error.code, 'INVALID_EMAIL_OR_PASSWORD')
    return true
  })
  assert.equal(passwordValidationError('short'), 'Hasło musi mieć co najmniej 12 znaków')
  assert.equal(passwordValidationError('x'.repeat(129)), 'Hasło może mieć maksymalnie 128 znaków')
  assert.equal(passwordValidationError('x'.repeat(12)), null)
})
