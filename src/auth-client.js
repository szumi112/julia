const AUTH_BASE = '/api/auth'

export class AuthRequestError extends Error {
  constructor(status, code) {
    super(code || 'AUTH_REQUEST_FAILED')
    this.name = 'AuthRequestError'
    this.status = status
    this.code = code || 'AUTH_REQUEST_FAILED'
  }
}

export const authStrategyFor = (mode) => {
  if (mode === 'demo') return 'demo'
  return mode === 'production' ? 'cloudflare-access' : 'better-auth'
}

export const passwordValidationError = (password) => {
  if (password.length < 12) return 'Hasło musi mieć co najmniej 12 znaków'
  if (password.length > 128) return 'Hasło może mieć maksymalnie 128 znaków'
  return null
}

export const resetTokenFromLocation = (search, hash) => {
  if (typeof search !== 'string' || typeof hash !== 'string' || hash !== '#/reset-password') return null
  const token = new URLSearchParams(search).get('token')
  return token && /^[A-Za-z0-9._~-]{1,512}$/.test(token) ? token : null
}

const normalizedEmail = (email) => email.trim().toLowerCase()

export function createAuthClient(fetchImpl = globalThis.fetch) {
  const request = async (path, { body, csrfToken, method = body ? 'POST' : 'GET' } = {}) => {
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken
    const response = await fetchImpl(path, {
      method,
      credentials: 'same-origin',
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json') ? await response.json() : null
    if (!response.ok) throw new AuthRequestError(response.status, payload?.error?.code || payload?.code)
    return payload
  }

  return Object.freeze({
    getConfig: () => request('/api/auth/config'),
    signInPassword: (email, password, rememberMe) => request(`${AUTH_BASE}/sign-in/email`, {
      body: { email: normalizedEmail(email), password, rememberMe },
    }),
    sendSignInOtp: (email) => request(`${AUTH_BASE}/email-otp/send-verification-otp`, {
      body: { email: normalizedEmail(email), type: 'sign-in' },
    }),
    signInOtp: (email, otp) => request(`${AUTH_BASE}/sign-in/email-otp`, {
      body: { email: normalizedEmail(email), otp },
    }),
    requestPasswordReset: (email, redirectTo) => request(`${AUTH_BASE}/request-password-reset`, {
      body: { email: normalizedEmail(email), redirectTo },
    }),
    resetPassword: (token, newPassword) => request(`${AUTH_BASE}/reset-password`, {
      body: { token, newPassword },
    }),
    listAccounts: () => request(`${AUTH_BASE}/list-accounts`),
    signOut: () => request(`${AUTH_BASE}/sign-out`, { body: {} }),
    setFirstPassword: (newPassword, csrfToken) => request('/api/v1/account/password', {
      body: { newPassword },
      csrfToken,
    }),
  })
}

export const authClient = createAuthClient()
