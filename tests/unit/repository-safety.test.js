import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  assertCoreMigrationConfiguration,
  assertDirectDependencyPins,
  assertRuntimeIndex,
  assertTrackedFiles,
  inspectDeployArtifact,
} from '../../scripts/assert-repository-safety.mjs'

const makeFixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bwm-repository-safety-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  return root
}

const write = (root, path, contents) => {
  const file = join(root, path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, contents)
  return file
}

const deployFixture = (t, options = {}) => {
  const root = makeFixture(t)
  const configPath = options.configPath || '../../dist/app/wrangler.generated.json'
  const workerConfig = options.workerConfig || {
    main: 'worker.js',
    assets: { directory: 'assets' },
  }
  write(root, '.wrangler/deploy/config.json', JSON.stringify({ configPath, auxiliaryWorkers: [] }))
  write(root, 'dist/app/wrangler.generated.json', JSON.stringify(workerConfig))
  write(root, 'dist/app/worker.js', options.worker || 'const DB = env.DB')
  write(root, 'dist/app/assets/index.html', options.html || '<script src="/assets/app.js"></script>')
  write(root, 'dist/app/assets/app.js', options.browser || 'console.log("app")')
  return root
}

test('tracked confidential files and test reports are rejected', () => {
  assert.doesNotThrow(() => assertTrackedFiles(['src/App.jsx', 'tests/unit/app-mode.test.js']))

  for (const path of [
    'Przychody.xlsx',
    '.env',
    '.env.production',
    '.dev.vars',
    '.dev.vars.local',
    'config/.env',
    'config/.envrc',
    'config/.env/secret',
    'nested/.dev.vars.backup',
    'config/.dev.vars/key',
    'sample.xlsx/contents',
    'playwright-report/index.html',
    'test-results/trace.zip',
    'foo/playwright-report/index.html',
    'foo/test-results/trace.zip',
    'dist/index.html',
    'nested/dist/asset.js',
    '.wrangler/deploy/config.json',
    'nested/.wrangler/state.json',
    '.core-migrations/active/0009_core_directory_expand.sql',
    'nested/.core-migrations/active/0009_core_directory_expand.sql',
  ]) {
    assert.throws(() => assertTrackedFiles([path]), /Forbidden tracked files/)
  }
})

test('D1 configuration exposes only the ignored generated migration directory', () => {
  assert.doesNotThrow(() => assertCoreMigrationConfiguration({
    d1_databases: [{ binding: 'DB', migrations_dir: '.core-migrations/active' }],
  }))
  for (const migrationsDir of [
    'migrations',
    './migrations',
    '.core-migrations',
    '.core-migrations/active/../later',
  ]) {
    assert.throws(() => assertCoreMigrationConfiguration({
      d1_databases: [{ binding: 'DB', migrations_dir: migrationsDir }],
    }), /generated core migration directory/)
  }
})

test('environment D1 blocks must also use the generated migration directory', () => {
  const compliantDatabase = { binding: 'DB', migrations_dir: '.core-migrations/active' }
  assert.doesNotThrow(() => assertCoreMigrationConfiguration({
    d1_databases: [compliantDatabase],
    env: {
      production: { d1_databases: [{ ...compliantDatabase }] },
      staging: { d1_databases: [{ ...compliantDatabase }] },
    },
  }))

  for (const environmentDatabases of [
    [{ binding: 'DB', migrations_dir: 'migrations' }],
    [{ binding: 'DB' }],
    [],
    'not-an-array',
  ]) {
    assert.throws(() => assertCoreMigrationConfiguration({
      d1_databases: [compliantDatabase],
      env: {
        production: { d1_databases: [{ ...compliantDatabase }] },
        staging: { d1_databases: environmentDatabases },
      },
    }), /generated core migration directory/)
  }
})

test('only exact direct dependency versions are accepted', () => {
  assert.doesNotThrow(() => assertDirectDependencyPins({
    dependencies: { react: '18.3.1' },
    devDependencies: { vite: '6.4.3' },
  }))

  for (const version of [
    '^18.3.1', '~18.3.1', '*', 'latest', 'https://example.test/pkg.tgz', 'workspace:*', 'file:../pkg',
    '01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3+', '1.2.3-01', '1.2.3-alpha.01',
  ]) {
    assert.throws(() => assertDirectDependencyPins({ dependencies: { example: version } }), /must use an exact semver version/)
  }
})

test('package keeps the complete script regression suite addressable', () => {
  const packageJson = JSON.parse(readFileSync(
    new URL('../../package.json', import.meta.url),
    'utf8',
  ))
  assert.equal(
    packageJson.scripts?.['test:scripts'],
    'node --test --test-concurrency=1 tests/scripts/*.test.js',
  )
})

test('workspace repositories remain pure and exclude persistence, queues, logging, and backend bindings', () => {
  const source = readFileSync(new URL('../../src/workspace-repository.js', import.meta.url), 'utf8')
  for (const forbidden of [
    /from ['"]react/, /localStorage/, /sessionStorage/, /indexedDB/, /CacheStorage/,
    /BroadcastChannel/, /serviceWorker/, /navigator/, /document\./, /window\./,
    /console\./, /analytics/i, /\benv\./, /\bDB\b/, /\bARCHIVE\b/,
    /retry/i, /queue/i,
  ]) assert.doesNotMatch(source, forbidden)
})

test('runtime HTML rejects external fonts and CDN scripts', () => {
  assert.doesNotThrow(() => assertRuntimeIndex('<!doctype html><script type="module" src="/assets/app.js"></script>'))

  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'CDN.JSDELIVR.NET']) {
    assert.throws(() => assertRuntimeIndex(`<link href="https://${host}/asset">`), /Runtime dependency remains/)
  }
})

test('deploy inspection follows structured config into the browser asset directory', (t) => {
  const root = deployFixture(t)
  assert.doesNotThrow(() => inspectDeployArtifact({ root, secretValues: {} }))
})

const environmentWorkerConfig = (overrides = {}) => ({
  main: 'worker.js',
  assets: { directory: 'assets' },
  targetEnvironment: 'staging',
  vars: {
    APP_ENV: 'staging',
    APP_ORIGIN: 'https://staging.bearwithme-panel.app',
  },
  d1_databases: [{
    binding: 'DB',
    database_name: 'bearwithme-panel-staging',
    database_id: '0b54f9d2-3c1e-4a87-9f26-8d5c1e7a4b90',
  }],
  ...overrides,
})

test('deploy inspection accepts an artifact resolved for the requested environment', (t) => {
  const root = deployFixture(t, { workerConfig: environmentWorkerConfig() })
  assert.doesNotThrow(() => inspectDeployArtifact({ root, secretValues: {}, expectedEnvironment: 'staging' }))
  assert.doesNotThrow(() => inspectDeployArtifact({ root, secretValues: {} }))
})

test('deploy inspection rejects an artifact that does not target the requested environment', (t) => {
  const placeholderRoot = deployFixture(t)
  assert.throws(
    () => inspectDeployArtifact({ root: placeholderRoot, secretValues: {}, expectedEnvironment: 'production' }),
    /must target environment production/,
  )

  const mismatchedRoot = deployFixture(t, { workerConfig: environmentWorkerConfig() })
  assert.throws(
    () => inspectDeployArtifact({ root: mismatchedRoot, secretValues: {}, expectedEnvironment: 'production' }),
    /must target environment production/,
  )
})

test('deploy inspection rejects environment artifacts with development vars or placeholder databases', (t) => {
  const appEnvRoot = deployFixture(t, {
    workerConfig: environmentWorkerConfig({
      vars: { APP_ENV: 'development', APP_ORIGIN: 'https://staging.bearwithme-panel.app' },
    }),
  })
  assert.throws(
    () => inspectDeployArtifact({ root: appEnvRoot, secretValues: {}, expectedEnvironment: 'staging' }),
    /vars\.APP_ENV must be staging/,
  )

  for (const appOrigin of ['http://127.0.0.1:5174', 'http://localhost:5174', 'https://app.localhost', undefined]) {
    const originRoot = deployFixture(t, {
      workerConfig: environmentWorkerConfig({
        vars: { APP_ENV: 'staging', APP_ORIGIN: appOrigin },
      }),
    })
    assert.throws(
      () => inspectDeployArtifact({ root: originRoot, secretValues: {}, expectedEnvironment: 'staging' }),
      /vars\.APP_ORIGIN/,
    )
  }

  for (const databases of [
    [{ binding: 'DB', database_name: 'bearwithme-panel-staging', database_id: '00000000-0000-0000-0000-000000000001' }],
    [{ binding: 'DB', database_name: 'bearwithme-panel-staging' }],
    [],
    undefined,
  ]) {
    const databaseRoot = deployFixture(t, {
      workerConfig: environmentWorkerConfig({ d1_databases: databases }),
    })
    assert.throws(
      () => inspectDeployArtifact({ root: databaseRoot, secretValues: {}, expectedEnvironment: 'staging' }),
      /provisioned D1 database id/,
    )
  }
})

test('deploy inspection permits only the plugin auxiliaryWorkers shape', (t) => {
  const legacyRoot = deployFixture(t)
  write(legacyRoot, '.wrangler/deploy/config.json', JSON.stringify({
    configPath: '../../dist/app/wrangler.generated.json',
  }))
  assert.doesNotThrow(() => inspectDeployArtifact({ root: legacyRoot, secretValues: {} }))

  const nonemptyRoot = deployFixture(t)
  write(nonemptyRoot, '.wrangler/deploy/config.json', JSON.stringify({
    configPath: '../../dist/app/wrangler.generated.json',
    auxiliaryWorkers: ['not-allowed'],
  }))
  assert.throws(() => inspectDeployArtifact({ root: nonemptyRoot, secretValues: {} }), /auxiliaryWorkers/)

  const prerenderRoot = deployFixture(t)
  write(prerenderRoot, '.wrangler/deploy/config.json', JSON.stringify({
    configPath: '../../dist/app/wrangler.generated.json',
    auxiliaryWorkers: [],
    prerenderWorkerConfigPath: '../../dist/app/prerender.json',
  }))
  assert.throws(() => inspectDeployArtifact({ root: prerenderRoot, secretValues: {} }), /Deploy config/)

  const unknownRoot = deployFixture(t)
  write(unknownRoot, '.wrangler/deploy/config.json', JSON.stringify({
    configPath: '../../dist/app/wrangler.generated.json',
    auxiliaryWorkers: [],
    unexpected: true,
  }))
  assert.throws(() => inspectDeployArtifact({ root: unknownRoot, secretValues: {} }), /Deploy config/)
})

test('deploy inspection rejects an escaped generated Worker config', (t) => {
  const root = deployFixture(t)
  const escapedRoot = makeFixture(t)
  const escapedConfig = write(escapedRoot, 'worker.json', JSON.stringify({
    main: 'worker.js',
    assets: { directory: 'assets' },
  }))
  write(escapedRoot, 'worker.js', 'export default {}')
  write(escapedRoot, 'assets/index.html', '<main>escaped</main>')
  write(root, '.wrangler/deploy/config.json', JSON.stringify({
    configPath: relative(join(root, '.wrangler/deploy'), escapedConfig),
  }))
  assert.throws(() => inspectDeployArtifact({ root, secretValues: {} }), /project root|dist\/app/)
})

test('deploy inspection rejects an external symlink redirect even when it points back into dist/app', (t) => {
  const root = deployFixture(t)
  const externalRoot = makeFixture(t)
  symlinkSync(join(root, 'dist/app'), join(externalRoot, 'returning-app'))
  const redirectedConfig = join(externalRoot, 'returning-app/wrangler.generated.json')
  write(root, '.wrangler/deploy/config.json', JSON.stringify({
    configPath: relative(join(root, '.wrangler/deploy'), redirectedConfig),
  }))

  assert.throws(() => inspectDeployArtifact({ root, secretValues: {} }), /project root/)
})

test('deploy inspection rejects an escaped Worker main and assets directory', (t) => {
  const mainRoot = deployFixture(t)
  const escapedMainRoot = makeFixture(t)
  const escapedMain = write(escapedMainRoot, 'worker.js', 'export default {}')
  write(mainRoot, 'dist/app/wrangler.generated.json', JSON.stringify({
    main: relative(join(mainRoot, 'dist/app'), escapedMain),
    assets: { directory: 'assets' },
  }))
  assert.throws(() => inspectDeployArtifact({ root: mainRoot, secretValues: {} }), /project root|dist\/app/)

  const assetsRoot = deployFixture(t)
  const escapedAssetsRoot = makeFixture(t)
  const escapedAssets = write(escapedAssetsRoot, 'assets/index.html', '<main>escaped</main>')
  write(assetsRoot, 'dist/app/wrangler.generated.json', JSON.stringify({
    main: 'worker.js',
    assets: { directory: relative(join(assetsRoot, 'dist/app'), join(escapedAssetsRoot, 'assets')) },
  }))
  assert.throws(() => inspectDeployArtifact({ root: assetsRoot, secretValues: {} }), /project root|dist\/app/)
})

test('deploy inspection accepts only the sole redirect config when a path is supplied', (t) => {
  const root = deployFixture(t)
  const alternate = write(root, 'alternate-config.json', JSON.stringify({
    configPath: 'dist/app/wrangler.generated.json',
  }))
  assert.throws(() => inspectDeployArtifact({ root, configPath: alternate, secretValues: {} }), /sole.*config\.json|config\.json.*sole/i)
})

test('deploy inspection rejects symlinked dist and deploy parent directories', (t) => {
  const distRoot = deployFixture(t)
  renameSync(join(distRoot, 'dist'), join(distRoot, 'real-dist'))
  symlinkSync(join(distRoot, 'real-dist'), join(distRoot, 'dist'))
  assert.throws(() => inspectDeployArtifact({ root: distRoot, secretValues: {} }), /Symlink/)

  const deployRoot = deployFixture(t)
  renameSync(join(deployRoot, '.wrangler'), join(deployRoot, 'real-wrangler'))
  symlinkSync(join(deployRoot, 'real-wrangler'), join(deployRoot, '.wrangler'))
  assert.throws(() => inspectDeployArtifact({ root: deployRoot, secretValues: {} }), /Symlink/)
})

test('backend binding names cannot appear in browser files but may appear in Worker bundle', (t) => {
  const allowedRoot = deployFixture(t, { worker: 'const DB = env.DB; const ARCHIVE = env.ARCHIVE' })
  assert.doesNotThrow(() => inspectDeployArtifact({ root: allowedRoot, secretValues: {} }))

  const rejectedRoot = deployFixture(t, { browser: 'const DB = "backend binding"' })
  assert.throws(() => inspectDeployArtifact({ root: rejectedRoot, secretValues: {} }), /backend binding/i)
})

test('backup provider account and database bindings stay out of browser artifacts', (t) => {
  for (const binding of ['CF_ACCOUNT_ID', 'CF_D1_DATABASE_ID']) {
    const allowedRoot = deployFixture(t, { worker: `const value = env.${binding}` })
    assert.doesNotThrow(() => inspectDeployArtifact({ root: allowedRoot, secretValues: {} }))

    const rejectedRoot = deployFixture(t, { browser: `const value = '${binding}'` })
    assert.throws(() => inspectDeployArtifact({ root: rejectedRoot, secretValues: {} }), /backend binding/i)
  }
})

test('deploy inspection scans textual assets regardless of extension but ignores binary bytes', (t) => {
  const textualRoot = deployFixture(t)
  write(textualRoot, 'dist/app/assets/logo.svg', '<svg><!-- DB --></svg>')
  assert.throws(() => inspectDeployArtifact({ root: textualRoot, secretValues: {} }), /backend binding/i)

  const binaryRoot = deployFixture(t)
  write(binaryRoot, 'dist/app/assets/font.woff2', Buffer.from([0x44, 0x42, 0x00, 0xff]))
  assert.doesNotThrow(() => inspectDeployArtifact({ root: binaryRoot, secretValues: {} }))
})

test('deploy inspection redacts supplied secret values while naming the variable and file', (t) => {
  const secret = 'do-not-print-this-runtime-secret'
  const root = deployFixture(t, { browser: `const secret = '${secret}'` })
  let error
  try {
    inspectDeployArtifact({ root, secretValues: { BWM_DATA_KEK_V1: secret } })
  } catch (caught) {
    error = caught
  }

  assert.ok(error)
  assert.match(error.message, /BWM_DATA_KEK_V1/)
  assert.match(error.message, /dist\/app\/assets\/app\.js/)
  assert.doesNotMatch(error.message, new RegExp(secret))
})

test('deploy inspection scans the offline D1 bootstrap token without exposing its value', (t) => {
  const secret = 'offline-d1-bootstrap-token-must-not-ship'
  const root = deployFixture(t, { worker: `const accidental = '${secret}'` })
  let error
  try {
    inspectDeployArtifact({
      root,
      secretValues: { CF_D1_BOOTSTRAP_TOKEN: secret },
    })
  } catch (caught) {
    error = caught
  }

  assert.ok(error)
  assert.match(error.message, /CF_D1_BOOTSTRAP_TOKEN/)
  assert.match(error.message, /dist\/app\/worker\.js/)
  assert.doesNotMatch(error.message, new RegExp(secret))
})

test('deploy inspection redacts an injected D1 export token value', (t) => {
  const secret = 'd1-export-token-value-must-not-ship'
  const root = deployFixture(t, { worker: `const accidental = '${secret}'` })
  let error
  try {
    inspectDeployArtifact({
      root,
      secretValues: { CF_D1_EXPORT_TOKEN: secret },
    })
  } catch (caught) {
    error = caught
  }

  assert.ok(error)
  assert.match(error.message, /CF_D1_EXPORT_TOKEN/)
  assert.doesNotMatch(error.message, new RegExp(secret))
})

test('deploy inspection rejects malformed deploy output and runtime CDN references', (t) => {
  const malformedRoot = deployFixture(t)
  write(malformedRoot, '.wrangler/deploy/config.json', '{')
  assert.throws(() => inspectDeployArtifact({ root: malformedRoot, secretValues: {} }), /Invalid JSON/)

  const unexpectedRoot = deployFixture(t)
  write(unexpectedRoot, '.wrangler/deploy/extra.json', '{}')
  assert.throws(() => inspectDeployArtifact({ root: unexpectedRoot, secretValues: {} }), /Unexpected file/)

  const sourceMapRoot = deployFixture(t)
  write(sourceMapRoot, 'dist/app/assets/app.js.map', '{}')
  assert.throws(() => inspectDeployArtifact({ root: sourceMapRoot, secretValues: {} }), /source map/i)

  const cdnRoot = deployFixture(t, { html: '<script src="https://cdn.jsdelivr.net/npm/example"></script>' })
  assert.throws(() => inspectDeployArtifact({ root: cdnRoot, secretValues: {} }), /Runtime dependency remains/)
})

test('deploy inspection rejects symlinks and a non-config deploy directory entry', (t) => {
  const symlinkRoot = deployFixture(t)
  symlinkSync(join(symlinkRoot, 'dist/app/assets/app.js'), join(symlinkRoot, 'dist/app/assets/linked.js'))
  assert.throws(() => inspectDeployArtifact({ root: symlinkRoot, secretValues: {} }), /Symlink/)

  const deploySymlinkRoot = deployFixture(t)
  symlinkSync(join(deploySymlinkRoot, 'dist/app/worker.js'), join(deploySymlinkRoot, '.wrangler/deploy/worker.js'))
  assert.throws(() => inspectDeployArtifact({ root: deploySymlinkRoot, secretValues: {} }), /Unexpected file|Symlink/)
})
