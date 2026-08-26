import { capabilitiesForActor } from '../identity/policy.js'
import { issueCsrfToken } from '../security/csrf.js'
import { decryptForScope as decryptField, loadDataKey } from '../security/envelope.js'

const denied = () => { throw new Error('ACCESS_DENIED') }

export async function getSession({
  db,
  config,
  principal,
  actor,
  cryptoContext,
  nowMs,
  decryptForScope = decryptField,
  issueToken = issueCsrfToken,
  loadDataKey: loadKey = loadDataKey,
} = {}) {
  if (!db?.prepare || principal?.kind !== 'human' || typeof principal.subject !== 'string'
    || !actor?.id || !Number.isSafeInteger(actor.version) || actor.version < 1
    || !Number.isSafeInteger(nowMs)) denied()
  const row = await db.prepare(
    `SELECT display_name_envelope
     FROM staff_users
     WHERE id=? AND status='active' AND access_subject=? AND version=?`
  ).bind(actor.id, principal.subject, actor.version).first()
  if (!row) denied()

  let envelope
  try {
    envelope = JSON.parse(row.display_name_envelope)
  } catch {
    throw new Error('CRYPTO_FAILURE')
  }
  const dataKey = await loadKey(db, {
    envelope,
    expectedScope: cryptoContext.scope,
  })
  const displayName = await decryptForScope(cryptoContext.keyring, dataKey, {
    expectedScope: cryptoContext.scope,
    recordId: actor.id,
    field: 'display_name',
    envelope,
  })
  const csrfToken = await issueToken({
    subject: principal.subject,
    origin: config.appOrigin,
    keyring: cryptoContext.keyring,
    nowMs,
    ttlSeconds: 900,
  })
  const expiresUnix = Math.floor(nowMs / 1000) + 900
  const sessionActor = Object.freeze({
    id: actor.id,
    displayName,
    role: actor.role,
    specialistId: actor.specialistId,
    version: actor.version,
  })
  const capabilities = Object.freeze([...capabilitiesForActor(actor)].sort())
  return {
    data: {
      actor: sessionActor,
      capabilities,
      csrfToken,
      csrfExpiresAt: new Date(expiresUnix * 1000).toISOString(),
      environment: config.appEnv,
      dataMode: 'fictional',
    },
  }
}
