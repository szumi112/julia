import { describe, expect, it } from 'vitest'
import * as configModule from '../../worker/config.js'
import {
  loadAccessProviderConfig,
  loadConfig,
  loadEmailProviderConfig,
} from '../../worker/config.js'

describe('loadBackupProviderConfig', () => {
  it('exposes the isolated backup provider loader', () => {
    expect(typeof configModule.loadBackupProviderConfig).toBe('function')
  })
})

const valid = {
  APP_ENV: 'staging',
  APP_ORIGIN: 'https://staging.bearwithme-panel.app',
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

const backupConfig = Object.freeze({ appEnv: 'staging', activeBackupKekVersion: 1 })
const backupArchive = Object.create({
  delete() { throw new Error('must not invoke ARCHIVE.delete') },
  get() { throw new Error('must not invoke ARCHIVE.get') },
  list() { throw new Error('must not invoke ARCHIVE.list') },
  put() { throw new Error('must not invoke ARCHIVE.put') },
})
const backupEnv = (overrides = {}) => ({
  ARCHIVE: backupArchive,
  BWM_BACKUP_KEK_V1: valid.BWM_BACKUP_KEK_V1,
  CF_ACCOUNT_ID: 'a'.repeat(32),
  CF_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
  CF_D1_EXPORT_TOKEN: 'backup-export-token',
  ...overrides,
})

const expectBackupError = (env, config, message = 'BACKUP_CONFIG_INVALID') => {
  let caught
  try {
    configModule.loadBackupProviderConfig(env, config)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  expect(caught.message).toBe(message)
  expect(caught.message).not.toContain('boundary-marker')
}

describe('loadConfig', () => {
  it('accepts one exact HTTPS origin and versioned 32-byte keys', () => {
    expect(loadConfig(valid).appOrigin).toBe('https://staging.bearwithme-panel.app')
    expect(loadConfig({
      ...valid,
      APP_ENV: 'production',
      APP_ORIGIN: 'https://bearwithme-panel.app',
    }).appOrigin).toBe('https://bearwithme-panel.app')
  })

  it('returns the unchanged exact frozen public config without provider material', () => {
    const result = loadConfig(valid)
    expect(result).toEqual({
      appEnv: 'staging',
      dataMode: 'fictional',
      appOrigin: 'https://staging.bearwithme-panel.app',
      accessAudience: 'aud-1',
      accessHealthServiceTokenId: 'health-token-id',
      accessIssuer: 'https://bearwithme.cloudflareaccess.com',
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
      localAuth: false,
    })
    expect(Object.isFrozen(result)).toBe(true)
    for (const name of [
      'ARCHIVE',
      'CF_ACCOUNT_ID',
      'CF_D1_DATABASE_ID',
      'CF_D1_EXPORT_TOKEN',
      'backupProvider',
      'token',
    ]) expect(result).not.toHaveProperty(name)
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
    ['APP_ORIGIN', 'https://bearwithme-panel.app.attacker.example'],
    ['APP_ORIGIN', 'https://panel.bearwithme.pl'],
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
    ['development', 'https://staging.bearwithme-panel.app'],
    ['production', 'https://staging.bearwithme-panel.app'],
    ['staging', 'https://bearwithme-panel.app'],
    ['staging', 'https://other.bearwithme-panel.app'],
    ['production', 'https://bearwithme-panel.app/'],
    ['production', 'https://bearwithme-panel.app:443'],
  ])('rejects invalid %s origin form %s', (appEnv, appOrigin) => {
    expect(() => loadConfig({ ...valid, APP_ENV: appEnv, APP_ORIGIN: appOrigin })).toThrow()
  })
})

describe('loadBackupProviderConfig', () => {
  it.each(['staging', 'production'])('returns one frozen three-field provider object for %s', (appEnv) => {
    const result = configModule.loadBackupProviderConfig(backupEnv(), {
      appEnv,
      activeBackupKekVersion: 1,
    })
    expect(result).toEqual({
      accountId: 'a'.repeat(32),
      databaseId: '11111111-1111-4111-8111-111111111111',
      token: 'backup-export-token',
    })
    expect(Object.keys(result)).toEqual(['accountId', 'databaseId', 'token'])
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('uses the actual R2 binding without invoking prototype capabilities', async () => {
    const { env } = await import('cloudflare:workers')
    const result = configModule.loadBackupProviderConfig(backupEnv({ ARCHIVE: env.ARCHIVE }), backupConfig)
    expect(result.accountId).toBe('a'.repeat(32))
  })

  it('short-circuits development before observing even revoked or throwing environments', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const throwing = new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error('boundary-marker') },
      ownKeys() { throw new Error('boundary-marker') },
    })

    for (const env of [backupEnv(), throwing, revoked.proxy]) {
      expectBackupError(env, { appEnv: 'development', activeBackupKekVersion: 1 }, 'BACKUP_PROVIDER_DISABLED')
    }
  })

  it.each([
    [undefined],
    ['test'],
    ['qa'],
    [0],
  ])('rejects invalid application environments without leaking input', (appEnv) => {
    expectBackupError(backupEnv(), { appEnv, activeBackupKekVersion: 1 })
  })

  it('rejects inherited, accessor, symbol, non-enumerable, proxy, and non-ordinary config', () => {
    const inherited = Object.create({ appEnv: 'staging', activeBackupKekVersion: 1 })
    const accessor = { activeBackupKekVersion: 1 }
    Object.defineProperty(accessor, 'appEnv', { enumerable: true, get() { throw new Error('boundary-marker') } })
    const symbol = { ...backupConfig, [Symbol('boundary-marker')]: true }
    const hidden = { ...backupConfig }
    Object.defineProperty(hidden, 'appEnv', { enumerable: false, value: 'staging' })
    const proxy = new Proxy({ ...backupConfig }, { ownKeys() { throw new Error('boundary-marker') } })

    for (const config of [null, [], inherited, accessor, symbol, hidden, proxy]) {
      expectBackupError(backupEnv(), config)
    }
  })

  it.each([
    [0],
    [1.5],
    ['1'],
    [Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a non-canonical active backup KEK version', (activeBackupKekVersion) => {
    expectBackupError(backupEnv(), { appEnv: 'staging', activeBackupKekVersion })
  })

  it.each([
    ['CF_ACCOUNT_ID', '0'.repeat(32)],
    ['CF_ACCOUNT_ID', 'A'.repeat(32)],
    ['CF_ACCOUNT_ID', 'a'.repeat(31)],
    ['CF_ACCOUNT_ID', { toString: () => 'a'.repeat(32) }],
    ['CF_ACCOUNT_ID', new String('a'.repeat(32))],
    ['CF_D1_DATABASE_ID', '00000000-0000-0000-0000-000000000000'],
    ['CF_D1_DATABASE_ID', '00000000-0000-0000-0000-000000000001'],
    ['CF_D1_DATABASE_ID', '11111111-1111-4111-8111-11111111111A'],
    ['CF_D1_DATABASE_ID', { toString: () => '11111111-1111-4111-8111-111111111111' }],
    ['CF_D1_DATABASE_ID', new String('11111111-1111-4111-8111-111111111111')],
    ['CF_D1_EXPORT_TOKEN', ''],
    ['CF_D1_EXPORT_TOKEN', ' token'],
    ['CF_D1_EXPORT_TOKEN', 'token value'],
    ['CF_D1_EXPORT_TOKEN', 'token\u200bvalue'],
    ['CF_D1_EXPORT_TOKEN', 'token\nvalue'],
    ['CF_D1_EXPORT_TOKEN', 'change_me'],
    ['CF_D1_EXPORT_TOKEN', 'CHANGEME'],
    ['CF_D1_EXPORT_TOKEN', 'EXAMPLE'],
    ['CF_D1_EXPORT_TOKEN', 'PLACEHOLDER'],
    ['CF_D1_EXPORT_TOKEN', 'REPLACE_ME'],
    ['CF_D1_EXPORT_TOKEN', 'REPLACEME'],
    ['CF_D1_EXPORT_TOKEN', 'TODO'],
    ['CF_D1_EXPORT_TOKEN', 'YOUR_TOKEN_HERE'],
  ])('rejects invalid backup provider %s values', (name, value) => {
    expectBackupError(backupEnv({ [name]: value }), backupConfig)
  })

  it.each([
    'safe-change-me-token',
    'safe-changeme-token',
    'safe-example-token',
    'safe-placeholder-token',
    'safe-replace-me-token',
    'safe-replaceme-token',
    'safe-todo-token',
    'safe-your-token-here-token',
  ])('allows a provider token that merely contains placeholder text: %s', (token) => {
    expect(configModule.loadBackupProviderConfig(backupEnv({ CF_D1_EXPORT_TOKEN: token }), backupConfig).token)
      .toBe(token)
  })

  it('enforces UTF-8 token boundaries without accepting whitespace or controls', () => {
    expect(configModule.loadBackupProviderConfig(backupEnv({
      CF_D1_EXPORT_TOKEN: 'a'.repeat(4096),
    }), backupConfig).token).toHaveLength(4096)
    expectBackupError(backupEnv({ CF_D1_EXPORT_TOKEN: 'a'.repeat(4097) }), backupConfig)
    expect(configModule.loadBackupProviderConfig(backupEnv({
      CF_D1_EXPORT_TOKEN: '\u0105'.repeat(2048),
    }), backupConfig).token).toHaveLength(2048)
    expectBackupError(backupEnv({ CF_D1_EXPORT_TOKEN: '\u0105'.repeat(2049) }), backupConfig)
    expectBackupError(backupEnv({ CF_D1_EXPORT_TOKEN: 'a\u00a0b' }), backupConfig)
    expectBackupError(backupEnv({ CF_D1_EXPORT_TOKEN: 'a\u2028b' }), backupConfig)
  })

  it('rejects empty and oversized tokens before UTF-8 encoding', () => {
    const NativeTextEncoder = globalThis.TextEncoder
    const encodedLengths = []
    globalThis.TextEncoder = class extends NativeTextEncoder {
      encode(value) {
        encodedLengths.push(value.length)
        return super.encode(value)
      }
    }

    try {
      expectBackupError(backupEnv({ CF_D1_EXPORT_TOKEN: '' }), backupConfig)
      expectBackupError(backupEnv({ CF_D1_EXPORT_TOKEN: 'a'.repeat(1_000_000) }), backupConfig)
    } finally {
      globalThis.TextEncoder = NativeTextEncoder
    }

    expect(encodedLengths).toEqual([])
  })

  it('rejects missing, accessor, inherited, symbol-substitute, and changing required bindings', () => {
    const missingBindings = ['CF_ACCOUNT_ID', 'CF_D1_DATABASE_ID', 'CF_D1_EXPORT_TOKEN']
      .map((name) => {
        const candidate = backupEnv()
        delete candidate[name]
        return candidate
      })
    const accessor = backupEnv()
    Object.defineProperty(accessor, 'CF_ACCOUNT_ID', { enumerable: true, get() { throw new Error('boundary-marker') } })
    const inherited = Object.create(backupEnv())
    const symbolSubstitute = backupEnv()
    delete symbolSubstitute.CF_D1_DATABASE_ID
    symbolSubstitute[Symbol.for('CF_D1_DATABASE_ID')] = '11111111-1111-4111-8111-111111111111'
    const seen = new Map()
    const changing = new Proxy(backupEnv(), {
      getOwnPropertyDescriptor(target, property) {
        const calls = (seen.get(property) || 0) + 1
        seen.set(property, calls)
        if (calls > 1) throw new Error('boundary-marker')
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })

    for (const env of [null, ...missingBindings, accessor, inherited, symbolSubstitute]) {
      expectBackupError(env, backupConfig)
    }
    expect(configModule.loadBackupProviderConfig(changing, backupConfig).token).toBe('backup-export-token')
  })

  it('rejects malformed backup key names, missing active keys, and invalid selected keys without reading retained keys', () => {
    for (const name of [
      'BWM_BACKUP_KEK_V',
      'BWM_BACKUP_KEK_V0',
      'BWM_BACKUP_KEK_V01',
      'BWM_BACKUP_KEK_V1e0',
      'BWM_BACKUP_KEK_V9007199254740992',
    ]) expectBackupError(backupEnv({ [name]: valid.BWM_BACKUP_KEK_V1 }), backupConfig)

    const missing = backupEnv()
    delete missing.BWM_BACKUP_KEK_V1
    expectBackupError(missing, backupConfig)
    expectBackupError(backupEnv({ BWM_BACKUP_KEK_V1: 'short' }), backupConfig)

    let retainedReads = 0
    const retained = backupEnv()
    Object.defineProperty(retained, 'BWM_BACKUP_KEK_V2', {
      enumerable: true,
      get() {
        retainedReads += 1
        throw new Error('boundary-marker')
      },
    })
    expect(configModule.loadBackupProviderConfig(retained, backupConfig).token).toBe('backup-export-token')
    expect(retainedReads).toBe(0)
  })

  it('rejects missing or incomplete ARCHIVE capabilities through the fixed boundary', () => {
    const noArchive = backupEnv()
    delete noArchive.ARCHIVE
    const accessor = backupEnv()
    Object.defineProperty(accessor, 'ARCHIVE', { enumerable: true, get() { throw new Error('boundary-marker') } })
    const incomplete = backupEnv({ ARCHIVE: Object.create({ get() {}, put() {}, delete() {} }) })
    const capabilityProxy = backupEnv({ ARCHIVE: new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error('boundary-marker') },
      getPrototypeOf() { throw new Error('boundary-marker') },
    }) })

    for (const env of [noArchive, accessor, incomplete, capabilityProxy]) expectBackupError(env, backupConfig)
  })

  it('audits every required ARCHIVE capability once even when one is invalid', () => {
    const seen = []
    const archive = new Proxy({ delete: null, get() {}, list() {}, put() {} }, {
      getOwnPropertyDescriptor(target, property) {
        if (['delete', 'get', 'list', 'put'].includes(property)) seen.push(property)
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })

    expectBackupError(backupEnv({ ARCHIVE: archive }), backupConfig)
    expect(seen).toEqual(['delete', 'get', 'list', 'put'])
  })

  it('captures a changing ARCHIVE prototype chain once before resolving capabilities', () => {
    let prototypeReads = 0
    const prototype = { delete() {}, get() {}, list() {}, put() {} }
    const archive = new Proxy({}, {
      getPrototypeOf() {
        prototypeReads += 1
        if (prototypeReads > 1) throw new Error('boundary-marker')
        return prototype
      },
    })

    expect(configModule.loadBackupProviderConfig(backupEnv({ ARCHIVE: archive }), backupConfig))
      .toMatchObject({ token: 'backup-export-token' })
    expect(prototypeReads).toBe(1)
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
      appEnv: 'staging',
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
