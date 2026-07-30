import { describe, expect, it } from 'vitest'
import {
  loadAccessProviderConfig,
  loadConfig,
  loadEmailProviderConfig,
} from '../../worker/config.js'

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

describe('loadAccessProviderConfig', () => {
  const access = {
    CF_ACCOUNT_ID: 'a'.repeat(32),
    CF_ACCESS_GROUP_ID: '11111111-1111-4111-8111-111111111111',
    CF_ACCESS_GROUP_NAME: 'Bear with me Staff',
    CF_ACCESS_GROUP_TOKEN: 'provider-secret',
  }

  it('accepts only canonical provider values and returns an immutable isolated config', () => {
    const result = loadAccessProviderConfig(access, { appEnv: 'staging' })
    expect(result).toEqual({
      accountId: access.CF_ACCOUNT_ID,
      groupId: access.CF_ACCESS_GROUP_ID,
      groupName: access.CF_ACCESS_GROUP_NAME,
      token: access.CF_ACCESS_GROUP_TOKEN,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(loadConfig(valid)).not.toHaveProperty('accessProvider')
  })

  it('keeps development provider-disabled even when every binding is present', () => {
    expect(() => loadAccessProviderConfig(access, { appEnv: 'development' }))
      .toThrow(/^PROVIDER_DISABLED$/)
  })

  it.each([
    ['CF_ACCOUNT_ID', 'A'.repeat(32)],
    ['CF_ACCOUNT_ID', 'a'.repeat(31)],
    ['CF_ACCOUNT_ID', `${'a'.repeat(32)} `],
    ['CF_ACCESS_GROUP_ID', '11111111111141118111111111111111'],
    ['CF_ACCESS_GROUP_ID', '11111111-1111-4111-8111-11111111111A'],
    ['CF_ACCESS_GROUP_NAME', ' Bear with me Staff'],
    ['CF_ACCESS_GROUP_NAME', 'x'.repeat(121)],
    ['CF_ACCESS_GROUP_NAME', '\u0105'.repeat(61)],
    ['CF_ACCESS_GROUP_NAME', 'Staff\nGroup'],
    ['CF_ACCESS_GROUP_TOKEN', ''],
    ['CF_ACCESS_GROUP_TOKEN', ' token'],
    ['CF_ACCESS_GROUP_TOKEN', 'token value'],
  ])('rejects malformed %s with a fixed error that does not reveal the binding', (key, value) => {
    let error
    try {
      loadAccessProviderConfig({ ...access, [key]: value }, { appEnv: 'staging' })
    } catch (caught) {
      error = caught
    }
    expect(error?.message).toBe('PROVIDER_CONFIG_INVALID')
    if (String(value)) expect(error?.message).not.toContain(String(value))
  })
})

describe('loadEmailProviderConfig', () => {
  const email = {
    SCW_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
    SCW_FROM_EMAIL: 'powiadomienia@example.test',
    SCW_FROM_NAME: 'Bear with me',
    SCW_SECRET_KEY: 'provider-secret',
  }

  it('returns one immutable isolated provider config for canonical bindings', () => {
    const result = loadEmailProviderConfig(email, { appEnv: 'staging' })
    expect(result).toEqual({
      projectId: email.SCW_PROJECT_ID,
      fromEmail: email.SCW_FROM_EMAIL,
      fromName: email.SCW_FROM_NAME,
      secret: email.SCW_SECRET_KEY,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(loadConfig(valid)).not.toHaveProperty('emailProvider')
  })

  it('keeps development provider-disabled even when every binding is present', () => {
    expect(() => loadEmailProviderConfig(email, { appEnv: 'development' }))
      .toThrow(/^PROVIDER_DISABLED$/)
  })

  it('measures the canonical sender address limit in UTF-8 bytes', () => {
    const withinLimit = `${'\u0105'.repeat(120)}@x.pl`
    const overLimit = `${'\u0105'.repeat(125)}@x.pl`
    expect(new TextEncoder().encode(withinLimit).byteLength).toBe(245)
    expect(loadEmailProviderConfig({
      ...email,
      SCW_FROM_EMAIL: withinLimit,
    }, { appEnv: 'staging' }).fromEmail).toBe(withinLimit)
    expect(() => loadEmailProviderConfig({
      ...email,
      SCW_FROM_EMAIL: overLimit,
    }, { appEnv: 'staging' })).toThrow(/^PROVIDER_CONFIG_INVALID$/)
  })

  it.each([
    ['SCW_PROJECT_ID', '11111111111141118111111111111111'],
    ['SCW_PROJECT_ID', '11111111-1111-4111-8111-11111111111A'],
    ['SCW_PROJECT_ID', 'project_1'],
    ['SCW_FROM_EMAIL', ' Powiadomienia@example.test'],
    ['SCW_FROM_EMAIL', 'Powiadomienia@example.test'],
    ['SCW_FROM_EMAIL', 'Bear with me <powiadomienia@example.test>'],
    ['SCW_FROM_EMAIL', `${'a'.repeat(243)}@example.test`],
    ['SCW_FROM_NAME', ' Bear with me'],
    ['SCW_FROM_NAME', '\u0105'.repeat(61)],
    ['SCW_FROM_NAME', 'Bear\nwith me'],
    ['SCW_FROM_NAME', 'Bear\u0085with me'],
    ['SCW_FROM_NAME', 'Bear\u009fwith me'],
    ['SCW_SECRET_KEY', ''],
    ['SCW_SECRET_KEY', '   '],
    ['SCW_SECRET_KEY', 'secret value'],
  ])('rejects malformed %s with a fixed error that does not reveal the binding', (key, value) => {
    let error
    try {
      loadEmailProviderConfig({ ...email, [key]: value }, { appEnv: 'staging' })
    } catch (caught) {
      error = caught
    }
    expect(error?.message).toBe('PROVIDER_CONFIG_INVALID')
    if (String(value)) expect(error?.message).not.toContain(String(value))
  })

  it.each([undefined, {}, { appEnv: 'test' }, { appEnv: 'production-ish' }])(
    'fails closed for a missing or unknown application environment',
    (config) => {
      expect(() => loadEmailProviderConfig(email, config))
        .toThrow(/^PROVIDER_CONFIG_INVALID$/)
    },
  )
})
