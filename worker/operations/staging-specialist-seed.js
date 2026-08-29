import { loadConfig } from '../config.js'
import { createKeyring } from '../security/keyring.js'
import { materializeStagingSpecialists } from './staging-specialist-materializer.js'

const emptyResult = () => Object.freeze({
  created: 0,
  updated: 0,
  linked: 0,
  confirmed: 0,
})

export async function ensureStagingSpecialistProfiles({ env, scheduledTime } = {}) {
  const config = loadConfig(env)
  if (config.appEnv !== 'staging' || config.dataMode !== 'fictional') return emptyResult()
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0
    || !env?.DB?.prepare || !env?.DB?.batch) throw new Error('STAGING_SEED_INVALID')
  const keyring = await createKeyring(env, config)
  return materializeStagingSpecialists({
    appEnv: config.appEnv,
    dataMode: config.dataMode,
    db: env.DB,
    recoveryDb: env.DB,
    keyring,
    nowMs: scheduledTime,
  })
}
