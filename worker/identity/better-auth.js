import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { loadAuthConfig, loadEmailProviderConfig } from '../config.js'
import { AppError } from '../http/errors.js'
import { normalizeCanonicalEmail } from './canonical-email.js'
import { createKeyring } from '../security/keyring.js'
import { blindEmailCandidates, decryptForScope } from '../security/envelope.js'
import { sendAuthenticationEmail } from '../providers/resend-email.js'

const IDENTITY_SCOPE = { type: 'staff_directory', id: 'centre_1', purpose: 'identity' }
const FRESH_SECONDS = 600
const SEND_PATHS = new Set(['/email-otp/send-verification-otp', '/request-password-reset'])
const ACCOUNT_PATHS = new Set(['/list-accounts', '/change-password'])
const instances = new WeakMap()
const deny = () => { throw new AppError('ACCESS_DENIED') }
const authDenied = () => { throw new APIError('FORBIDDEN', { code: 'ACCESS_DENIED', message: 'Brak dostępu do panelu.' }) }

export const usesBetterAuth = config => ['development', 'staging'].includes(config?.appEnv)

async function eligibleStaff(db, env, config, email, nowMs = Date.now()) {
  const normalized = normalizeCanonicalEmail(email, { fictional: config.appEnv === 'development' })
  if (!normalized) return null
  const keyring = await createKeyring(env, config)
  const candidates = await blindEmailCandidates(normalized, keyring)
  const rows = (await db.prepare(`SELECT id,status,access_subject,email_envelope,role FROM staff_users
    WHERE email_lookup IN (${candidates.map(() => '?').join(',')}) AND status IN ('active','pending')`)
    .bind(...candidates).all()).results
  if (rows.length !== 1) return null
  const staff = rows[0]
  const dataKey = await db.prepare('SELECT * FROM data_keys WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1')
    .bind(IDENTITY_SCOPE.type, IDENTITY_SCOPE.id, IDENTITY_SCOPE.purpose).first()
  if (!dataKey) throw new Error('CRYPTO_FAILURE')
  const storedEmail = await decryptForScope(keyring, dataKey, {
    expectedScope: IDENTITY_SCOPE, recordId: staff.id, field: 'email', envelope: JSON.parse(staff.email_envelope),
  })
  if (storedEmail !== normalized) return null
  if (staff.status === 'pending') {
    const invitation = await db.prepare(`SELECT id FROM staff_invitations WHERE staff_id=? AND role=?
      AND status='pending' AND expires_at>? AND access_allowed_at IS NOT NULL`)
      .bind(staff.id, staff.role, new Date(nowMs).toISOString()).first()
    if (!invitation) return null
  }
  return { ...staff, normalizedEmail: normalized }
}

export function createBetterAuth({ env, config, db = env.DB, sendEmail } = {}) {
  const settings = loadAuthConfig(env, config)
  const send = async message => {
    if (sendEmail) return sendEmail(message)
    const provider = loadEmailProviderConfig(env, config)
    return sendAuthenticationEmail({
      ...provider, fetch, appOrigin: config.appOrigin, jobId: crypto.randomUUID(), ...message,
    })
  }
  let auth
  auth = betterAuth({
    appName: 'Bear with me',
    baseURL: config.appOrigin,
    basePath: '/api/auth',
    secret: settings.secret,
    database: db,
    trustedOrigins: [config.appOrigin],
    user: { modelName: 'auth_user', changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    session: {
      modelName: 'auth_session', expiresIn: 8 * 60 * 60, freshAge: FRESH_SECONDS,
      disableSessionRefresh: true, cookieCache: { enabled: false },
    },
    account: { modelName: 'auth_account', accountLinking: { enabled: false } },
    verification: { modelName: 'auth_verification', storeIdentifier: 'hashed' },
    emailAndPassword: {
      enabled: true, disableSignUp: true, requireEmailVerification: true,
      minPasswordLength: 12, maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 1800, revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        if (await eligibleStaff(db, env, config, user.email)) await send({ recipient: user.email, purpose: 'reset', url })
      },
    },
    plugins: [emailOTP({
      otpLength: 6, expiresIn: 300, allowedAttempts: 3, storeOTP: 'hashed',
      disableSignUp: false,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== 'sign-in' || !(await eligibleStaff(db, env, config, email))) authDenied()
        await send({ recipient: email, purpose: 'otp', otp })
      },
    })],
    advanced: {
      cookiePrefix: 'bwm-auth', useSecureCookies: config.appEnv !== 'development',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    rateLimit: {
      enabled: true, storage: 'database', modelName: 'auth_rate_limit', window: 60, max: 100,
      customRules: {
        '/email-otp/send-verification-otp': { window: 60, max: 3 },
        '/request-password-reset': { window: 60, max: 3 },
      },
    },
    disabledPaths: ['/sign-up/email', '/update-user', '/change-email', '/delete-user', '/get-access-token', '/refresh-token', '/account-info', '/unlink-account', '/email-otp/request-password-reset', '/email-otp/reset-password', '/email-otp/verify-email', '/email-otp/check-verification-otp'],
    logger: { disabled: true },
    onAPIError: { errorURL: `${config.appOrigin}/#/login` },
    hooks: {
      before: createAuthMiddleware(async ctx => {
        if (SEND_PATHS.has(ctx.path) || ['/sign-in/email', '/sign-in/email-otp'].includes(ctx.path)) {
          const email = normalizeCanonicalEmail(ctx.body?.email)
          const staff = await eligibleStaff(db, env, config, email)
          if (!staff) {
            if (SEND_PATHS.has(ctx.path)) return ctx.json({ success: true })
            authDenied()
          }
          ctx.body.email = staff.normalizedEmail
          if (ctx.path === '/email-otp/send-verification-otp' && ctx.body.type !== 'sign-in') authDenied()
        }
        if (ACCOUNT_PATHS.has(ctx.path)) {
          const session = await auth.api.getSession({ headers: ctx.headers })
          if (!session?.user.emailVerified || !(await eligibleStaff(db, env, config, session.user.email))) authDenied()
          if (ctx.path !== '/list-accounts' && Date.now() - session.session.createdAt.getTime() > FRESH_SECONDS * 1000) {
            throw new APIError('UNAUTHORIZED', { code: 'REAUTH_REQUIRED', message: 'Zaloguj się ponownie.' })
          }
        }
      }),
    },
    databaseHooks: {
      user: { create: { before: async user => {
        const staff = await eligibleStaff(db, env, config, user.email)
        if (!staff || !user.emailVerified) authDenied()
        return { data: { ...user, name: staff.id, image: null } }
      } } },
      session: { create: { before: async session => {
        const user = await db.prepare('SELECT email,emailVerified FROM auth_user WHERE id=?').bind(session.userId).first()
        if (!user?.emailVerified || !(await eligibleStaff(db, env, config, user.email))) authDenied()
        return { data: { ...session, expiresAt: new Date(Math.min(
          new Date(session.expiresAt).getTime(), new Date(session.createdAt).getTime() + 8 * 60 * 60 * 1000,
        )) } }
      } } },
    },
  })
  return auth
}

export function runtimeBetterAuth(env, config) {
  let auth = instances.get(env)
  if (!auth) {
    auth = createBetterAuth({ env, config })
    instances.set(env, auth)
  }
  return auth
}

export async function resolveBetterAuthPrincipal(request, { env, config, db = env.DB, auth = runtimeBetterAuth(env, config), nowMs = Date.now() } = {}) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) throw new AppError('AUTH_REQUIRED')
  if (!session.user.emailVerified) deny()
  const staff = await eligibleStaff(db, env, config, session.user.email, nowMs)
  if (!staff) deny()
  const issuedAt = Math.floor(new Date(session.session.createdAt).getTime() / 1000)
  const expiresAt = Math.floor(new Date(session.session.expiresAt).getTime() / 1000)
  if (expiresAt <= Math.floor(nowMs / 1000) || issuedAt > Math.floor(nowMs / 1000)) throw new AppError('REAUTH_REQUIRED')
  await db.prepare('INSERT INTO staff_auth_identities (auth_user_id,staff_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING')
    .bind(session.user.id, staff.id, new Date(nowMs).toISOString()).run()
  const binding = await db.prepare('SELECT staff_id FROM staff_auth_identities WHERE auth_user_id=?').bind(session.user.id).first()
  if (binding?.staff_id !== staff.id) deny()
  return Object.freeze({
    kind: 'human', subject: staff.access_subject ?? `ba:${session.user.id}`,
    normalizedEmail: staff.normalizedEmail, issuedAt, expiresAt, authUserId: session.user.id,
  })
}

export async function setInitialPassword(auth, request, principal, newPassword, nowMs) {
  if (!principal.authUserId || nowMs / 1000 - principal.issuedAt > FRESH_SECONDS) throw new AppError('REAUTH_REQUIRED')
  if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128) throw new AppError('VALIDATION_FAILED', { field: 'body' })
  try {
    await auth.api.setPassword({ headers: request.headers, body: { newPassword } })
  } catch (error) {
    if (error instanceof APIError && error.statusCode < 500) throw new AppError('VALIDATION_FAILED', { field: 'body' })
    throw error
  }
  return { data: { success: true } }
}
