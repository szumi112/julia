import { capabilitiesForActor } from '../identity/policy.js'
import { isD1MissingColumn } from '../db/errors.js'
import { issueCsrfToken } from '../security/csrf.js'
import { decryptForScope as decryptField, loadDataKey } from '../security/envelope.js'
import { isWellFormedUnicode } from '../../src/core-records.js'

const denied = () => { throw new Error('ACCESS_DENIED') }
const titleFailure = () => { throw new Error('CRYPTO_FAILURE') }

const validProfessionalTitle = (value) => {
  if (typeof value !== 'string' || !isWellFormedUnicode(value) || value !== value.trim()
    || value !== value.normalize('NFC') || /[\p{Cc}\p{Cf}]/u.test(value)) return false
  const encoded = new TextEncoder().encode(value)
  const valid = encoded.byteLength >= 1 && encoded.byteLength <= 120
  encoded.fill(0)
  return valid
}

const sessionRowSql = (withTitle) => `
  SELECT staff.display_name_envelope,staff.role,staff.specialist_id,
         specialist.id AS profile_id,specialist.staff_user_id AS profile_staff_user_id,
         specialist.status AS profile_status
         ${withTitle ? ',specialist.professional_title_envelope' : ''}
  FROM staff_users AS staff
  LEFT JOIN specialists AS specialist
    ON specialist.id=staff.specialist_id AND specialist.staff_user_id=staff.id
  WHERE staff.id=? AND staff.status='active' AND staff.access_subject=? AND staff.version=?`

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
  let row
  let withTitle = true
  try {
    row = await db.prepare(sessionRowSql(true))
      .bind(actor.id, principal.subject, actor.version).first()
  } catch (error) {
    if (!isD1MissingColumn(error, 'specialist.professional_title_envelope')) throw error
    withTitle = false
    row = await db.prepare(sessionRowSql(false))
      .bind(actor.id, principal.subject, actor.version).first()
  }
  if (!row || row.role !== actor.role || row.specialist_id !== actor.specialistId) denied()
  const linked = row.specialist_id !== null
  if (linked !== (row.profile_id !== null)
    || (linked && (row.profile_id !== row.specialist_id
      || row.profile_staff_user_id !== actor.id
      || !['active', 'pending'].includes(row.profile_status)))) denied()

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
  let professionalTitle = null
  if (linked) {
    if (!withTitle || row.professional_title_envelope === null) {
      professionalTitle = 'Specjalistka'
    } else {
      let titleEnvelope
      try { titleEnvelope = JSON.parse(row.professional_title_envelope) } catch { titleFailure() }
      professionalTitle = await decryptForScope(cryptoContext.keyring, dataKey, {
        expectedScope: cryptoContext.scope,
        recordId: row.profile_id,
        field: 'professional_title',
        envelope: titleEnvelope,
      })
      if (!validProfessionalTitle(professionalTitle)) titleFailure()
    }
  }
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
    professionalTitle,
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
