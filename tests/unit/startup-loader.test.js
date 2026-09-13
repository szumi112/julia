import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const index = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const main = readFileSync(new URL('../../src/main.jsx', import.meta.url), 'utf8')
const startupStyles = index.match(/<style>([\s\S]*?)<\/style>/)?.[1] || ''
const startupMarkup = index.match(/<div id="root">([\s\S]*?)<\/div>\s*<script/)?.[1] || ''

test('the document provides a self-contained startup loader until React renders', () => {
  assert.match(index, /<div id="root">\s*<div class="startup-loader">/)
  assert.match(index, /<svg[^>]*viewBox="0 0 48 48"[^>]*aria-hidden="true"/)
  assert.match(index, /<path d="M11 39V23a8\.5 8\.5 0 0 1 17 0v16" stroke="var\(--pink, currentColor\)"/)
  assert.match(index, /<p class="startup-loader__label">Otwieramy panel…<\/p>/)
  assert.match(startupStyles, /background: var\(--paper, Canvas\)/)
  assert.match(startupStyles, /color: var\(--ink, CanvasText\)/)
  assert.match(index, /animation:\s*startup-loader-label 0s linear 300ms forwards/)
  assert.doesNotMatch(startupStyles, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(startupMarkup, /#[0-9a-f]{3,8}\b/i)
  assert.match(main, /createRoot\(document\.getElementById\('root'\)\)\.render/)
})
