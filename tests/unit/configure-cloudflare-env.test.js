import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { assertCoreMigrationConfiguration } from '../../scripts/assert-repository-safety.mjs'
import {
  applyProviderResults,
  serializeWranglerConfig,
} from '../../scripts/configure-cloudflare-env.mjs'

const scriptPath = fileURLToPath(new URL('../../scripts/configure-cloudflare-env.mjs', import.meta.url))
const repositoryWranglerUrl = new URL('../../wrangler.json', import.meta.url)

// Frozen local-shape baseline mirroring wrangler.json before any env blocks exist.
// Deliberately not read from the live repo file: once the writer runs for real the
// repo wrangler.json gains an env key and expectations derived from it would drift.
const baseConfig = () => ({
  name: 'bearwithme-panel',
  main: './worker/index.js',
  compatibility_date: '2026-07-29',
  workers_dev: false,
  preview_urls: false,
  assets: {
    binding: 'ASSETS',
    not_found_handling: 'single-page-application',
    run_worker_first: ['/api/*'],
  },
  d1_databases: [{
    binding: 'DB',
    database_name: 'bearwithme-panel-local',
    database_id: '00000000-0000-0000-0000-000000000001',
    preview_database_id: 'bearwithme-panel-local',
    migrations_dir: '.core-migrations/active',
  }],
  r2_buckets: [{ binding: 'ARCHIVE', bucket_name: 'bearwithme-panel-local', jurisdiction: 'eu' }],
  triggers: { crons: ['* * * * *', '*/5 * * * *'] },
  vars: {
    APP_ENV: 'development',
    APP_ORIGIN: 'http://127.0.0.1:5174',
    DATA_MODE: 'fictional',
    ACCESS_AUD: 'local-access-audience',
    ACCESS_HEALTH_SERVICE_TOKEN_ID: 'local-health-service',
    ACCESS_TEAM_DOMAIN: 'https://local.cloudflareaccess.com',
    ACTIVE_DATA_KEK_VERSION: '1',
    ACTIVE_LOOKUP_KEY_VERSION: '1',
    ACTIVE_BACKUP_KEK_VERSION: '1',
  },
  secrets: {
    required: ['BWM_BACKUP_KEK_V1', 'BWM_DATA_KEK_V1', 'BWM_LOOKUP_HMAC_V1'],
  },
})

const validDocument = () => ({
  staging: {
    accountId: '4c7d8a2f1e5b09c3a6d4e8f2b1a3c5d7',
    appOrigin: 'https://staging.bearwithme-panel.app',
    d1: {
      id: '0b54f9d2-3c1e-4a87-9f26-8d5c1e7a4b90',
      name: 'bearwithme-panel-staging',
      jurisdiction: 'eu',
    },
    r2: { name: 'bearwithme-panel-staging', jurisdiction: 'eu' },
    accessAudience: '5f2b8c1d9e4a7f30b6c2d8e1f4a9b5c7d3e0f6a2b8c4d1e7f3a0b6c9d2e5f8a1',
    accessGroupId: '3f8e2d1c-9b4a-4c6d-8e2f-1a3b5c7d9e0f',
    accessGroupName: 'Bear with me - panel - staging',
    accessHealthServiceTokenId: '7d4e1f8a2b5c9d30e6f1a4b7c2d5e8f0.access',
    accessTeamDomain: 'https://example-team.cloudflareaccess.com',
    scaleway: {
      projectId: '9c6b3a80-5d2e-4f17-8b4a-0c3d6e9f2a51',
      fromEmail: 'panel@example-domain.pl',
      fromName: 'Bear with me',
    },
  },
  production: {
    accountId: '4c7d8a2f1e5b09c3a6d4e8f2b1a3c5d7',
    appOrigin: 'https://bearwithme-panel.app',
    d1: {
      id: '7e2a9c41-6f3d-4b58-8a19-2c7e5d0f9b34',
      name: 'bearwithme-panel-production',
      jurisdiction: 'eu',
    },
    r2: { name: 'bearwithme-panel-production', jurisdiction: 'eu' },
    accessAudience: 'a1c4e7f0b3d6a9c2e5f8b1d4a7c0e3f6b9d2a5c8e1f4b7d0a3c6e9f2b5d8a1c4',
    accessGroupId: '8b1d4f7a-2c5e-4d08-9f3b-6a1c4e7d0f92',
    accessGroupName: 'Bear with me - panel - production',
    accessHealthServiceTokenId: '2f9c6d3e0a7b4c1d8e5f2a9b6c3d0e7f.access',
    accessTeamDomain: 'https://example-team.cloudflareaccess.com',
    scaleway: {
      projectId: '9c6b3a80-5d2e-4f17-8b4a-0c3d6e9f2a51',
      fromEmail: 'panel@example-domain.pl',
      fromName: 'Bear with me',
    },
  },
})

const expectedEnvironmentBlock = (name, section) => {
  const vars = {
    APP_ENV: name,
    APP_ORIGIN: section.appOrigin,
    DATA_MODE: 'fictional',
    ACCESS_AUD: section.accessAudience,
    ACCESS_HEALTH_SERVICE_TOKEN_ID: section.accessHealthServiceTokenId,
    ACCESS_TEAM_DOMAIN: section.accessTeamDomain,
    ACTIVE_DATA_KEK_VERSION: '1',
    ACTIVE_LOOKUP_KEY_VERSION: '1',
    ACTIVE_BACKUP_KEK_VERSION: '1',
    CF_ACCOUNT_ID: section.accountId,
    CF_D1_DATABASE_ID: section.d1.id,
    CF_ACCESS_GROUP_ID: section.accessGroupId,
    CF_ACCESS_GROUP_NAME: section.accessGroupName,
  }
  if (section.scaleway) {
    vars.SCW_PROJECT_ID = section.scaleway.projectId
    vars.SCW_FROM_EMAIL = section.scaleway.fromEmail
    vars.SCW_FROM_NAME = section.scaleway.fromName
  }
  return {
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: new URL(section.appOrigin).hostname, custom_domain: true }],
    vars,
    secrets: {
      required: [
        'BWM_BACKUP_KEK_V1',
        'BWM_DATA_KEK_V1',
        'BWM_LOOKUP_HMAC_V1',
        'CF_ACCESS_GROUP_TOKEN',
        'CF_D1_EXPORT_TOKEN',
        'SCW_SECRET_KEY',
      ],
    },
    d1_databases: [{
      binding: 'DB',
      database_name: section.d1.name,
      database_id: section.d1.id,
      migrations_dir: '.core-migrations/active',
    }],
    r2_buckets: [{ binding: 'ARCHIVE', bucket_name: section.r2.name, jurisdiction: 'eu' }],
    observability: { enabled: true },
  }
}

const makeFixture = (t, { config = baseConfig(), document = validDocument() } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'bwm-configure-cloudflare-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const wranglerPath = join(root, 'wrangler.json')
  writeFileSync(wranglerPath, `${JSON.stringify(config, null, 2)}\n`)
  const documentPath = join(root, 'provider-results.json')
  writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`)
  return { documentPath, root, wranglerPath }
}

const runScript = (args) => spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })

const rejects = (mutate, pattern, config = baseConfig()) => {
  const document = validDocument()
  mutate(document)
  assert.throws(() => applyProviderResults({ config, document }), pattern)
}

test('CLI writes complete staging and production environments for a valid provider document', (t) => {
  const document = validDocument()
  const { documentPath, wranglerPath } = makeFixture(t, { document })
  const result = runScript([documentPath, '--wrangler', wranglerPath])

  assert.equal(result.status, 0, result.stderr)
  const output = readFileSync(wranglerPath, 'utf8')
  const written = JSON.parse(output)

  assert.deepEqual(written.env.staging, expectedEnvironmentBlock('staging', document.staging))
  assert.deepEqual(written.env.production, expectedEnvironmentBlock('production', document.production))
  assert.deepEqual(written.secrets.required, [
    'BWM_BACKUP_KEK_V1',
    'BWM_DATA_KEK_V1',
    'BWM_LOOKUP_HMAC_V1',
    'CF_ACCESS_GROUP_TOKEN',
    'CF_D1_EXPORT_TOKEN',
    'SCW_SECRET_KEY',
  ])

  const before = baseConfig()
  for (const key of Object.keys(before)) {
    if (key !== 'secrets') assert.deepEqual(written[key], before[key])
  }
  assert.deepEqual(Object.keys(written), [...Object.keys(before), 'env'])
  assert.deepEqual(Object.keys(written.env), ['staging', 'production'])
  assert.deepEqual(Object.keys(written.env.staging.vars), [
    'APP_ENV',
    'APP_ORIGIN',
    'DATA_MODE',
    'ACCESS_AUD',
    'ACCESS_HEALTH_SERVICE_TOKEN_ID',
    'ACCESS_TEAM_DOMAIN',
    'ACTIVE_DATA_KEK_VERSION',
    'ACTIVE_LOOKUP_KEY_VERSION',
    'ACTIVE_BACKUP_KEK_VERSION',
    'CF_ACCOUNT_ID',
    'CF_D1_DATABASE_ID',
    'CF_ACCESS_GROUP_ID',
    'CF_ACCESS_GROUP_NAME',
    'SCW_PROJECT_ID',
    'SCW_FROM_EMAIL',
    'SCW_FROM_NAME',
  ])

  assert.equal(output, serializeWranglerConfig(written))
  assert.ok(output.endsWith('}\n'))
  assert.doesNotMatch(output, /CLOUDFLARE_INCLUDE_PROCESS_ENV/)
  for (const line of output.split('\n')) {
    if (line.includes('@')) assert.match(line, /SCW_FROM_EMAIL/)
  }
})

test('CLI output is deterministic across runs and idempotent on its own output', (t) => {
  const first = makeFixture(t)
  const second = makeFixture(t)
  assert.equal(runScript([first.documentPath, '--wrangler', first.wranglerPath]).status, 0)
  assert.equal(runScript([second.documentPath, '--wrangler', second.wranglerPath]).status, 0)
  const firstOutput = readFileSync(first.wranglerPath, 'utf8')
  assert.equal(firstOutput, readFileSync(second.wranglerPath, 'utf8'))

  assert.equal(runScript([first.documentPath, '--wrangler', first.wranglerPath]).status, 0)
  assert.equal(readFileSync(first.wranglerPath, 'utf8'), firstOutput)
})

test('a pre-existing env key is overwritten in place without duplicating config keys', () => {
  const document = validDocument()
  const configured = applyProviderResults({ config: baseConfig(), document }).config
  const stale = JSON.parse(JSON.stringify(configured))
  stale.env.staging.vars.APP_ORIGIN = 'https://stale-staging.bearwithme-panel.app'
  delete stale.env.production

  const { config: rewritten } = applyProviderResults({ config: stale, document })
  assert.deepEqual(Object.keys(rewritten), Object.keys(stale))
  assert.equal(Object.keys(rewritten).filter((key) => key === 'env').length, 1)
  assert.deepEqual(rewritten.env, configured.env)
})

test('the writer accepts the live repo wrangler.json shape', () => {
  const repositoryConfig = JSON.parse(readFileSync(repositoryWranglerUrl, 'utf8'))
  const { config } = applyProviderResults({ config: repositoryConfig, document: validDocument() })
  assert.deepEqual(Object.keys(config.env), ['staging', 'production'])
  assert.deepEqual(config.secrets.required, [
    'BWM_BACKUP_KEK_V1',
    'BWM_DATA_KEK_V1',
    'BWM_LOOKUP_HMAC_V1',
    'CF_ACCESS_GROUP_TOKEN',
    'CF_D1_EXPORT_TOKEN',
    'SCW_SECRET_KEY',
  ])
})

test('emitted configuration still passes assertCoreMigrationConfiguration and keeps per-env migration directories', () => {
  const { config, warnings } = applyProviderResults({ config: baseConfig(), document: validDocument() })
  assert.deepEqual(warnings, [])
  assert.doesNotThrow(() => assertCoreMigrationConfiguration(config))
  for (const name of ['staging', 'production']) {
    assert.equal(config.env[name].d1_databases[0].migrations_dir, '.core-migrations/active')
  }
})

test('emitted configuration inherits the two top-level crons and writes no per-env triggers', () => {
  const { config } = applyProviderResults({ config: baseConfig(), document: validDocument() })
  assert.deepEqual(config.triggers.crons, ['* * * * *', '*/5 * * * *'])
  for (const name of ['staging', 'production']) {
    assert.ok(!Object.hasOwn(config.env[name], 'triggers'))
  }
})

test('a missing scaleway section omits SCW_ vars for that environment and warns about dead-lettered invitation emails', (t) => {
  const document = validDocument()
  delete document.staging.scaleway

  const { config, warnings } = applyProviderResults({ config: baseConfig(), document })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /staging/)
  assert.match(warnings[0], /dead-letter/)
  for (const name of ['SCW_PROJECT_ID', 'SCW_FROM_EMAIL', 'SCW_FROM_NAME']) {
    assert.ok(!Object.hasOwn(config.env.staging.vars, name))
    assert.ok(Object.hasOwn(config.env.production.vars, name))
  }

  const { documentPath, wranglerPath } = makeFixture(t, { document })
  const result = runScript([documentPath, '--wrangler', wranglerPath])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /staging/)
  assert.match(result.stderr, /dead-letter/)
})

test('account ids must be exactly 32 lowercase hex characters', () => {
  for (const accountId of [
    '', 'abc',
    '4C7D8A2F1E5B09C3A6D4E8F2B1A3C5D7',
    '4c7d8a2f1e5b09c3a6d4e8f2b1a3c5d',
    '4c7d8a2f1e5b09c3a6d4e8f2b1a3c5d7a',
    'zz7d8a2f1e5b09c3a6d4e8f2b1a3c5d7',
  ]) {
    rejects((document) => { document.production.accountId = accountId }, /production\.accountId must be exactly 32 lowercase hex/)
  }
})

test('database ids must be lowercase UUIDs and never zeroed or local placeholders', () => {
  for (const id of [
    'not-a-uuid',
    '0B54F9D2-3C1E-4A87-9F26-8D5C1E7A4B90',
    '0b54f9d2-3c1e-4a87-9f26-8d5c1e7a4b9',
    '0b54f9d23c1e4a879f268d5c1e7a4b90',
  ]) {
    rejects((document) => { document.staging.d1.id = id }, /staging\.d1\.id must be a lowercase UUID/)
  }

  for (const id of [
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-00000000000f',
  ]) {
    rejects((document) => { document.staging.d1.id = id }, /staging\.d1\.id must not be a zeroed placeholder/)
  }

  const config = baseConfig()
  config.d1_databases[0].database_id = '11111111-2222-4333-8444-555555555555'
  rejects((document) => { document.staging.d1.id = '11111111-2222-4333-8444-555555555555' }, /staging\.d1\.id must differ from the local placeholder database id/, config)
})

test('D1 and R2 jurisdictions must be exactly "eu"', () => {
  for (const jurisdiction of ['us', 'EU', '', undefined]) {
    rejects((document) => { document.staging.d1.jurisdiction = jurisdiction }, /staging\.d1\.jurisdiction/)
    rejects((document) => { document.production.r2.jurisdiction = jurisdiction }, /production\.r2\.jurisdiction/)
  }
})

test('resource names must be non-empty, differ across environments, and differ from the local names', () => {
  rejects((document) => { document.staging.d1.name = '' }, /staging\.d1\.name must be a non-empty trimmed string/)
  rejects((document) => { document.staging.r2.name = ' padded ' }, /staging\.r2\.name must be a non-empty trimmed string/)
  rejects((document) => { document.production.d1.name = 'bearwithme-panel-local' }, /production\.d1\.name must differ from the local resource name/)
  rejects((document) => { document.production.r2.name = 'bearwithme-panel-local' }, /production\.r2\.name must differ from the local resource name/)
  rejects((document) => { document.production.d1.name = document.staging.d1.name }, /must not share d1\.name/)
  rejects((document) => { document.production.r2.name = document.staging.r2.name }, /must not share r2\.name/)
})

test('app origins must be exact public https origins and differ across environments', () => {
  for (const appOrigin of [
    'http://staging.bearwithme-panel.app',
    'https://staging.bearwithme-panel.app/',
    'https://staging.bearwithme-panel.app/app',
    'https://staging.bearwithme-panel.app?query',
    'https://staging.bearwithme-panel.app#hash',
    'https://user:secret@staging.bearwithme-panel.app',
    'https://staging.bearwithme-panel.app:8443',
    'https://localhost',
    'https://app.localhost',
    'https://203.0.113.5',
    'https://[2001:db8::1]',
    'https://staging-panel.test',
    'https://staging-panel.local',
    'https://staging-panel.cloudflareaccess.com',
    ' https://staging.bearwithme-panel.app',
    '',
    42,
  ]) {
    rejects((document) => { document.staging.appOrigin = appOrigin }, /staging\.appOrigin/)
  }
  rejects((document) => { document.production.appOrigin = document.staging.appOrigin }, /must not share appOrigin/)
})

test('app origins outside the worker runtime domain pin fail the imported loadConfig gate', () => {
  for (const appOrigin of [
    'https://staging.example-domain.app',
    'https://bearwithme-panel.app.example-domain.app',
    'https://notbearwithme-panel.app',
  ]) {
    rejects(
      (document) => { document.staging.appOrigin = appOrigin },
      /staging vars were rejected by worker\/config\.js loadConfig: APP_ORIGIN/,
    )
  }
  rejects(
    (document) => { document.production.appOrigin = 'https://panel.example-domain.pl' },
    /production vars were rejected by worker\/config\.js loadConfig: APP_ORIGIN/,
  )
})

test('access team domains must match the shape of worker/config.js isAccessTeamDomain', () => {
  for (const accessTeamDomain of [
    'http://example-team.cloudflareaccess.com',
    'https://example.com',
    'https://cloudflareaccess.com',
    'https://a.b.cloudflareaccess.com',
    'https://-team.cloudflareaccess.com',
    'https://example-team.cloudflareaccess.com/login',
    'https://example-team.cloudflareaccess.com:8443',
    '',
  ]) {
    rejects((document) => { document.production.accessTeamDomain = accessTeamDomain }, /production\.accessTeamDomain/)
  }
  rejects((document) => { document.staging.accessTeamDomain = 'https://local.cloudflareaccess.com' }, /staging\.accessTeamDomain must not be the local placeholder team domain/)
})

test('access identifiers must be non-empty, trimmed, UUID-shaped where required, and never local placeholders', () => {
  rejects((document) => { document.staging.accessAudience = '' }, /staging\.accessAudience must be a non-empty trimmed string/)
  rejects((document) => { document.staging.accessAudience = '  ' }, /staging\.accessAudience must be a non-empty trimmed string/)
  rejects((document) => { document.staging.accessAudience = 'local-access-audience' }, /staging\.accessAudience must not be a local placeholder/)
  rejects((document) => { document.production.accessHealthServiceTokenId = 'local-health-service' }, /production\.accessHealthServiceTokenId must not be a local placeholder/)
  rejects((document) => { document.production.accessHealthServiceTokenId = ' padded ' }, /production\.accessHealthServiceTokenId must be a non-empty trimmed string/)
  rejects((document) => { document.staging.accessGroupId = 'not-a-uuid' }, /staging\.accessGroupId must be a lowercase UUID/)
  rejects((document) => { document.production.accessGroupName = '' }, /production\.accessGroupName must be a non-empty trimmed string/)
})

test('staging and production must not share environment-specific identifiers', () => {
  for (const [label, mutate] of [
    ['d1.id', (document) => { document.production.d1.id = document.staging.d1.id }],
    ['r2.name', (document) => { document.production.r2.name = document.staging.r2.name }],
    ['accessAudience', (document) => { document.production.accessAudience = document.staging.accessAudience }],
    ['accessGroupId', (document) => { document.production.accessGroupId = document.staging.accessGroupId }],
    ['accessHealthServiceTokenId', (document) => {
      document.production.accessHealthServiceTokenId = document.staging.accessHealthServiceTokenId
    }],
  ]) {
    rejects(mutate, new RegExp(`must not share ${label.replace('.', '\\.')}`))
  }
})

test('malformed documents and unknown fields are rejected', () => {
  assert.throws(() => applyProviderResults({ config: baseConfig(), document: [] }), /provider document must be a JSON object/)
  assert.throws(() => applyProviderResults({ config: baseConfig(), document: null }), /provider document must be a JSON object/)
  rejects((document) => { delete document.production }, /production is required/)
  rejects((document) => { document.staging = 'not-an-object' }, /staging must be an object/)
  rejects((document) => { delete document.staging.accessAudience }, /staging\.accessAudience is required/)
  rejects((document) => { document.staging.token = 'anything' }, /staging\.token is not a recognized field/)
  rejects((document) => { document.extra = {} }, /extra is not a recognized field/)
  rejects((document) => { delete document.production.d1.id }, /production\.d1\.id is required/)
})

test('a present scaleway section is fully validated', () => {
  rejects((document) => { document.staging.scaleway.projectId = 'not-a-uuid' }, /staging\.scaleway\.projectId must be a lowercase UUID/)
  rejects((document) => { document.staging.scaleway.fromEmail = 'Panel@Example-Domain.pl' }, /staging\.scaleway\.fromEmail/)
  rejects((document) => { document.staging.scaleway.fromEmail = 'no-at-sign' }, /staging\.scaleway\.fromEmail/)
  rejects((document) => { document.production.scaleway.fromName = '' }, /production\.scaleway\.fromName must be a non-empty trimmed string/)
  rejects((document) => { delete document.production.scaleway.fromName }, /production\.scaleway\.fromName is required/)
  rejects((document) => { document.production.scaleway.secretKey = 'nope' }, /production\.scaleway\.secretKey is not a recognized field/)
})

test('the wrangler config must provide the inherited key-version vars', () => {
  for (const name of ['ACTIVE_DATA_KEK_VERSION', 'ACTIVE_LOOKUP_KEY_VERSION', 'ACTIVE_BACKUP_KEK_VERSION']) {
    const config = baseConfig()
    delete config.vars[name]
    assert.throws(
      () => applyProviderResults({ config, document: validDocument() }),
      new RegExp(name)
    )
  }
})

test('CLI exits non-zero and leaves the wrangler config untouched on validation failure', (t) => {
  const document = validDocument()
  document.staging.accountId = 'NOT-HEX'
  const { documentPath, wranglerPath } = makeFixture(t, { document })
  const before = readFileSync(wranglerPath, 'utf8')

  const result = runScript([documentPath, '--wrangler', wranglerPath])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /staging\.accountId/)
  assert.equal(readFileSync(wranglerPath, 'utf8'), before)
})

test('CLI rejects missing arguments, unknown flags, and unreadable or invalid documents', (t) => {
  const usagePattern = /Usage: node scripts\/configure-cloudflare-env\.mjs/

  const noArguments = runScript([])
  assert.notEqual(noArguments.status, 0)
  assert.match(noArguments.stderr, usagePattern)

  const { documentPath, root, wranglerPath } = makeFixture(t)
  const unknownFlag = runScript([documentPath, '--wrangler', wranglerPath, '--force'])
  assert.notEqual(unknownFlag.status, 0)
  assert.match(unknownFlag.stderr, usagePattern)

  const missingDocument = runScript([join(root, 'absent.json'), '--wrangler', wranglerPath])
  assert.notEqual(missingDocument.status, 0)
  assert.match(missingDocument.stderr, /Cannot read provider document/)

  const invalidPath = join(root, 'invalid.json')
  writeFileSync(invalidPath, 'not json')
  const invalidDocument = runScript([invalidPath, '--wrangler', wranglerPath])
  assert.notEqual(invalidDocument.status, 0)
  assert.match(invalidDocument.stderr, /Invalid JSON in provider document/)

  assert.equal(readFileSync(wranglerPath, 'utf8'), `${JSON.stringify(baseConfig(), null, 2)}\n`)
})
