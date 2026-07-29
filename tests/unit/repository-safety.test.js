import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
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
  write(root, '.wrangler/deploy/config.json', JSON.stringify({ configPath }))
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
    'nested/.dev.vars.backup',
    'playwright-report/index.html',
    'test-results/trace.zip',
    'foo/playwright-report/index.html',
    'foo/test-results/trace.zip',
  ]) {
    assert.throws(() => assertTrackedFiles([path]), /Forbidden tracked files/)
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
