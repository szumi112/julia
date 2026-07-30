import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import {
  buildBootstrapCreationBatch,
  inspectBootstrapAggregate,
} from '../../scripts/bootstrap-core.js'
import { NOW_MS } from './fixtures.js'
import {
  bootstrapInput,
  bootstrapKeyring,
  executeBootstrapBatch,
} from './bootstrap-helpers.js'

it('creates the complete encrypted pre-reconcile aggregate in one guarded batch', async () => {
  const keyring = await bootstrapKeyring('1')
  const built = await buildBootstrapCreationBatch({
    ...bootstrapInput('1'),
    keyring,
  })
  expect(built.batch.length).toBeGreaterThan(8)
  expect(built.batch.every(({ params }) => params.every(
    (value) => typeof value === 'string',
  ))).toBe(true)
  const results = await executeBootstrapBatch(built.batch)
  expect(results.at(-1)?.results).toEqual([built.proof])
  await expect(inspectBootstrapAggregate({
    db: env.DB,
    keyring,
    nowMs: NOW_MS,
    ownerDisplayName: 'Alicja Testowa 1',
    ownerEmail: 'owner-1@example.test',
  })).resolves.toMatchObject({
    ids: built.ids,
    kind: 'pre-reconcile',
    reconcileState: 'queued-initial',
  })
  const raw = JSON.stringify((await env.DB.prepare(
    `SELECT email_envelope,display_name_envelope,payload_envelope,snapshot_envelope
     FROM staff_users
     JOIN outbox_jobs ON 1=1
     JOIN record_versions ON 1=1`
  ).all()).results)
  expect(raw).not.toContain('owner-1@example.test')
  expect(raw).not.toContain('Alicja Testowa 1')
})
