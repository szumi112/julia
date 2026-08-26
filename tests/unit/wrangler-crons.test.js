import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const configPath = new URL('../../wrangler.json', import.meta.url)

test('Wrangler registers separate minute and five-minute scheduled invocations', async () => {
  const config = JSON.parse(await readFile(configPath, 'utf8'))

  assert.deepEqual(config.triggers?.crons, [
    '* * * * *',
    '*/5 * * * *',
  ])
})
