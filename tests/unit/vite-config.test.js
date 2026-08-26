import test from 'node:test'
import assert from 'node:assert/strict'
import viteConfig from '../../vite.config.js'

const configFor = (mode) => viteConfig({
  command: 'build',
  isPreview: false,
  isSsrBuild: false,
  mode,
})

test('protected builds preserve identifiers without disabling other esbuild minification', () => {
  for (const mode of ['app', 'production', 'staging']) {
    assert.deepEqual(configFor(mode).esbuild, { minifyIdentifiers: false }, mode)
  }

  assert.equal(configFor('demo').esbuild, undefined)
})
