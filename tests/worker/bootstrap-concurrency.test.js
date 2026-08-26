import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { buildBootstrapCreationBatch } from '../../scripts/bootstrap-core.js'
import {
  bootstrapInput,
  bootstrapKeyring,
  executeBootstrapBatch,
} from './bootstrap-helpers.js'

it('allows exactly one winner across concurrent different-owner batches', async () => {
  const keyring = await bootstrapKeyring('3')
  const [first, second] = await Promise.all([
    buildBootstrapCreationBatch({ ...bootstrapInput('3'), keyring }),
    buildBootstrapCreationBatch({ ...bootstrapInput('4'), keyring }),
  ])
  const settled = await Promise.allSettled([
    executeBootstrapBatch(first.batch),
    executeBootstrapBatch(second.batch),
  ])
  expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  expect(await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first())
    .toEqual({ count: 1 })
  expect(await env.DB.prepare(
    "SELECT value_json,version FROM system_state WHERE key='access.desired_generation'"
  ).first()).toEqual({
    value_json: '{"generation":1}',
    version: 2,
  })
})
