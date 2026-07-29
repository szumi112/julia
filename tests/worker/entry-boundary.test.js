import { describe, expect, it } from 'vitest'
import worker from '../../worker/index.js'

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
    expect(() => worker.scheduled(
      {},
      { ...valid, ACTIVE_DATA_KEK_VERSION: '01' },
      { waitUntil() {} }
    )).toThrow()
  })
})
