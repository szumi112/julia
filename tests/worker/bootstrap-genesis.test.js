import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import {
  buildBootstrapCreationBatch,
  inspectBootstrapSchema,
} from '../../scripts/bootstrap-core.js'
import { NOW_MS } from './fixtures.js'
import {
  bootstrapInput,
  bootstrapKeyring,
  executeBootstrapBatch,
} from './bootstrap-helpers.js'

it('refuses poisoned Access state on an empty directory and the create guard cannot adopt it', async () => {
  const now = new Date(NOW_MS).toISOString()
  await env.DB.prepare(
    `UPDATE system_state
     SET value_json='{"generation":1}',version=2,updated_at=?
     WHERE key='access.desired_generation'`
  ).bind(now).run()
  await expect(inspectBootstrapSchema(env.DB)).resolves.toEqual({
    kind: 'refused',
  })

  const keyring = await bootstrapKeyring('poisoned')
  const built = await buildBootstrapCreationBatch({
    ...bootstrapInput('poisoned'),
    keyring,
  })
  await expect(executeBootstrapBatch(built.batch)).rejects.toThrow(
    /outbox_operation_guard_failed/,
  )
  expect(await env.DB.prepare('SELECT count(*) AS count FROM data_keys').first())
    .toEqual({ count: 0 })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first())
    .toEqual({ count: 0 })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM outbox_jobs').first())
    .toEqual({ count: 0 })
})
