import test from 'node:test'
import assert from 'node:assert/strict'
import { appModeFrom, appSurfaceFor, basePathFor } from '../../src/app-mode.js'

test('demo is the only mode that keeps the public GitHub Pages behavior', () => {
  assert.equal(appModeFrom('demo'), 'demo')
  assert.equal(basePathFor('demo'), '/julia/')
})

test('development, staging, and production use the protected app shape', () => {
  for (const mode of ['app', 'staging', 'production']) {
    assert.equal(appModeFrom(mode), 'app')
    assert.equal(basePathFor(mode), '/')
  }
})

test('only demo mode may render the in-memory demo surface', () => {
  assert.equal(appSurfaceFor('demo'), 'demo')

  for (const mode of ['app', 'staging', 'production', undefined]) {
    assert.equal(appSurfaceFor(mode), 'protected')
  }
})
