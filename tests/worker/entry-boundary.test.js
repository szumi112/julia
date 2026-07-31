import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../../worker/index.js'
import { getOrCreateDataKey } from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'

const valid = {
  APP_ENV: 'development',
  APP_ORIGIN: 'http://127.0.0.1:5174',
  DATA_MODE: 'fictional',
  ACCESS_AUD: 'aud-1',
  ACCESS_HEALTH_SERVICE_TOKEN_ID: 'health-token-id',
  ACCESS_TEAM_DOMAIN: 'https://bearwithme.cloudflareaccess.com',
  ACTIVE_DATA_KEK_VERSION: '1',
  ACTIVE_LOOKUP_KEY_VERSION: '1',
  ACTIVE_BACKUP_KEK_VERSION: '1',
  BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  BWM_BACKUP_KEK_V1: 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
}

describe('Worker entry boundary', () => {
  it('rejects malformed configuration before serving a health response', async () => {
    expect(() => worker.fetch(
      new Request('https://example.test/api/v1/health/live'),
      { ...valid, APP_ORIGIN: '*' },
      { waitUntil() {} }
    )).toThrow()
  })

  it('requires a service assertion after accepting runtime configuration', async () => {
    const response = await worker.fetch(
      new Request('https://example.test/api/v1/health/live'),
      valid,
      { waitUntil() {} }
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'ACCESS_ASSERTION_INVALID' },
    })
  })

  it('rejects malformed configuration before scheduling work', () => {
    let waitUntilCalls = 0
    expect(() => worker.scheduled(
      {},
      { ...valid, ACTIVE_DATA_KEK_VERSION: '01' },
      { waitUntil() { waitUntilCalls += 1 } }
    )).toThrow()
    expect(waitUntilCalls).toBe(0)
  })

  it('validates configuration first and gives one promise ownership of scheduled completion', async () => {
    const scheduledTime = Date.parse('2038-01-15T00:00:00.000Z')
    const runtimeEnv = { ...env, ...valid, DB: env.DB }
    const keyring = await createKeyring(runtimeEnv, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
    await getOrCreateDataKey(
      env.DB,
      keyring,
      { type: 'staff_directory', id: 'centre_1', purpose: 'identity' },
      {
        id: 'key_entry_scheduler',
        createdAt: '2038-01-15T00:00:00.000Z',
      },
    )
    const promises = []

    expect(worker.scheduled(
      { scheduledTime },
      runtimeEnv,
      { waitUntil(promise) { promises.push(promise) } }
    )).toBeUndefined()
    expect(promises).toHaveLength(1)

    await expect(promises[0]).resolves.toMatchObject({
      status: 'succeeded',
      reason: null,
    })
    expect(await env.DB.prepare(
      'SELECT scheduled_for,status FROM scheduler_runs WHERE scheduled_for=?'
    ).bind('2038-01-15T00:00:00.000Z').first()).toEqual({
      scheduled_for: '2038-01-15T00:00:00.000Z',
      status: 'succeeded',
    })
  })
})
