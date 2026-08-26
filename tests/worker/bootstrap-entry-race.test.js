import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import {
  buildBootstrapCreationBatch,
  inspectBootstrapEntryState,
} from '../../scripts/bootstrap-core.js'
import {
  bootstrapInput,
  bootstrapKeyring,
  executeBootstrapBatch,
} from './bootstrap-helpers.js'

it('classifies entry from one snapshot when a concurrent winner commits immediately after it', async () => {
  const input = bootstrapInput('entry_race')
  const keyring = await bootstrapKeyring('entry_race')
  const winner = await buildBootstrapCreationBatch({ ...input, keyring })
  let snapshotCalls = 0
  const db = {
    prepare: (sql) => env.DB.prepare(sql),
    async batch(statements) {
      snapshotCalls += 1
      const captured = await env.DB.batch(statements)
      if (snapshotCalls === 1) await executeBootstrapBatch(winner.batch)
      return captured
    },
  }

  await expect(inspectBootstrapEntryState({
    db,
    keyring,
    nowMs: input.nowMs,
    ownerDisplayName: input.ownerDisplayName,
    ownerEmail: input.ownerEmail,
  })).resolves.toEqual({ kind: 'empty' })
  expect(snapshotCalls).toBe(1)
})
