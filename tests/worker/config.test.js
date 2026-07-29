import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../worker/config.js'

const valid = {
  APP_ENV: 'staging',
  APP_ORIGIN: 'https://staging-panel.bearwithme.pl',
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

describe('loadConfig', () => {
  it('accepts one exact HTTPS origin and versioned 32-byte keys', () => {
    expect(loadConfig(valid).appOrigin).toBe('https://staging-panel.bearwithme.pl')
  })

  it('allows exact loopback origins only in development', () => {
    expect(loadConfig({
      ...valid,
      APP_ENV: 'development',
      APP_ORIGIN: 'http://127.0.0.1:5174',
    }).localAuth).toBe(true)
  })

  it.each([
    ['APP_ORIGIN', '*'],
    ['APP_ORIGIN', 'https://panel.bearwithme.pl.attacker.example'],
    ['ACCESS_TEAM_DOMAIN', 'http://bearwithme.cloudflareaccess.com'],
    ['ACCESS_TEAM_DOMAIN', 'https://bearwithme.cloudflareaccess.com.attacker.example'],
    ['ACCESS_TEAM_DOMAIN', 'https://nested.bearwithme.cloudflareaccess.com'],
    ['ACCESS_HEALTH_SERVICE_TOKEN_ID', '   '],
    ['BWM_DATA_KEK_V1', 'short'],
    ['BWM_DATA_KEK_V1', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
    ['BWM_DATA_KEK_V1', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA '],
    ['BWM_DATA_KEK_V1', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/'],
    ['ACTIVE_DATA_KEK_VERSION', '01'],
    ['ACTIVE_DATA_KEK_VERSION', '1e0'],
    ['ACTIVE_DATA_KEK_VERSION', ' 1'],
    ['ACTIVE_DATA_KEK_VERSION', '0'],
  ])('fails closed for invalid %s', (key, value) => {
    expect(() => loadConfig({ ...valid, [key]: value })).toThrow()
  })

  it.each([
    ['production', 'http://127.0.0.1:5174'],
    ['staging', 'http://localhost:5174'],
    ['development', 'https://staging-panel.bearwithme.pl'],
    ['production', 'https://panel.bearwithme.pl/'],
    ['production', 'https://panel.bearwithme.pl:443'],
  ])('rejects invalid %s origin form %s', (appEnv, appOrigin) => {
    expect(() => loadConfig({ ...valid, APP_ENV: appEnv, APP_ORIGIN: appOrigin })).toThrow()
  })
})
