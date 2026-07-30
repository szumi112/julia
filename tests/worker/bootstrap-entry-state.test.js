import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import {
  buildBootstrapCreationBatch,
  inspectBootstrapEntryState,
} from '../../scripts/bootstrap-core.js'
import {
  bootstrapInput,
  bootstrapKeyring,
} from './bootstrap-helpers.js'

it('distinguishes the exact empty genesis from partial state before ID generation', async () => {
  const keyring = await bootstrapKeyring('entry_state')
  await expect(inspectBootstrapEntryState({
    db: env.DB,
    keyring,
    nowMs: bootstrapInput('entry_state').nowMs,
    ownerDisplayName: bootstrapInput('entry_state').ownerDisplayName,
    ownerEmail: bootstrapInput('entry_state').ownerEmail,
  })).resolves.toEqual({ kind: 'empty' })

  const built = await buildBootstrapCreationBatch({
    ...bootstrapInput('entry_state'),
    keyring,
  })
  await env.DB.prepare(built.batch[0].sql).bind(...built.batch[0].params).run()
  await expect(inspectBootstrapEntryState({
    db: env.DB,
    keyring,
    nowMs: bootstrapInput('entry_state').nowMs,
    ownerDisplayName: bootstrapInput('entry_state').ownerDisplayName,
    ownerEmail: bootstrapInput('entry_state').ownerEmail,
  })).resolves.toEqual({ kind: 'refused' })
})
