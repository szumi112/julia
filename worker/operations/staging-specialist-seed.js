import { createSpecialistProfile } from '../core/specialist-profiles.js'
import { loadConfig } from '../config.js'
import { createKeyring } from '../security/keyring.js'

const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const PROFILES = Object.freeze([
  Object.freeze({
    displayName: 'Anna Janowska',
    id: 'sp_staging_workbook_anna_janowska',
    standardRateGrosze: 18000,
  }),
  Object.freeze({
    displayName: 'Julia Wolanin',
    id: 'sp_staging_workbook_julia_wolanin',
    standardRateGrosze: 18000,
  }),
  Object.freeze({
    displayName: 'Justyna J-J',
    id: 'sp_staging_workbook_justyna_j_j',
    standardRateGrosze: 18000,
  }),
])

const suffix = () => crypto.randomUUID().replaceAll('-', '')
const idFactoryFor = (profileId) => {
  let profilePending = true
  return () => {
    if (profilePending) {
      profilePending = false
      return profileId.slice(3)
    }
    return suffix()
  }
}

export async function ensureStagingSpecialistProfiles({ env, scheduledTime } = {}) {
  const config = loadConfig(env)
  if (config.appEnv !== 'staging' || config.dataMode !== 'fictional') {
    return Object.freeze({ createdOrConfirmed: 0 })
  }
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0
    || !env?.DB?.prepare || !env?.DB?.batch) throw new Error('STAGING_SEED_INVALID')
  const ownerRows = (await env.DB.prepare(
    `SELECT id,role,specialist_id,version
     FROM staff_users WHERE role='owner' AND status='active' ORDER BY id LIMIT 2`,
  ).all()).results
  if (!Array.isArray(ownerRows) || ownerRows.length !== 1) {
    throw new Error('STAGING_SEED_INVALID')
  }
  const owner = Object.freeze({
    id: ownerRows[0].id,
    role: ownerRows[0].role,
    specialistId: ownerRows[0].specialist_id,
    version: ownerRows[0].version,
  })
  const keyring = await createKeyring(env, config)
  const dataKey = await env.DB.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
            kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1
       AND retired_at IS NULL`,
  ).bind(SCOPE.type, SCOPE.id, SCOPE.purpose).first()
  if (!dataKey) throw new Error('STAGING_SEED_INVALID')
  for (const [index, profile] of PROFILES.entries()) {
    const existing = await env.DB.prepare(
      `SELECT id,staff_user_id,status,version,archived_at
       FROM specialists WHERE id=?`,
    ).bind(profile.id).first()
    if (existing) {
      if (existing.id !== profile.id || !['active', 'pending'].includes(existing.status)
        || existing.version < 1 || existing.archived_at !== null) {
        throw new Error('STAGING_SEED_INVALID')
      }
      continue
    }
    await createSpecialistProfile({
      db: env.DB,
      recoveryDb: env.DB,
      actor: owner,
      keyring,
      nowMs: scheduledTime,
      correlationId: crypto.randomUUID(),
      idFactory: idFactoryFor(profile.id),
      body: {
        displayName: profile.displayName,
        standardRateGrosze: profile.standardRateGrosze,
      },
      idempotencyKey: `staging-workbook-specialist-${index + 1}`,
    })
  }
  return Object.freeze({ createdOrConfirmed: PROFILES.length })
}
