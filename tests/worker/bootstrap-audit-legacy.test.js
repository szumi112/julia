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

it('keeps an exact Phase 1 bootstrap audit row append-only while inspecting it', async () => {
  const keyring = await bootstrapKeyring('legacy')
  const built = await buildBootstrapCreationBatch({
    ...bootstrapInput('legacy'),
    keyring,
  })
  const legacy = '{"desiredGeneration":1,"invitationVersion":1,"staffVersion":1}'
  const current = '{"desiredGeneration":1,"invitationVersion":1,"specialistVersion":null,"staffVersion":1}'
  let replacements = 0
  const phase1Batch = built.batch.map((entry) => ({
    ...entry,
    params: entry.params.map((value) => {
      if (value !== current) return value
      replacements += 1
      return legacy
    }),
  }))
  expect(replacements).toBe(2)
  await executeBootstrapBatch(phase1Batch)

  await expect(inspectBootstrapAggregate({
    db: env.DB,
    keyring,
    nowMs: NOW_MS,
    ownerDisplayName: 'Alicja Testowa legacy',
    ownerEmail: 'owner-legacy@example.test',
  })).resolves.toMatchObject({ kind: 'pre-reconcile' })
  expect(await env.DB.prepare(
    "SELECT metadata_json FROM audit_events WHERE action='staff.bootstrap'"
  ).first()).toEqual({ metadata_json: legacy })
})
