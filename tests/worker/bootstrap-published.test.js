import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { inspectBootstrapAggregate } from '../../scripts/bootstrap-core.js'
import * as handlers from '../../worker/jobs/handlers.js'
import { processOutboxJobById } from '../../worker/jobs/outbox.js'
import { NOW_MS } from './fixtures.js'
import { createBootstrapFixture, sequence } from './bootstrap-helpers.js'

const correlationSequence = () => {
  let count = 0
  return () => `00000000-0000-4000-8000-${String(count += 1).padStart(12, '0')}`
}

it('recognizes exact Access publication and returns every opaque resume identifier', async () => {
  const fixture = await createBootstrapFixture('published')
  const nowMs = NOW_MS + 1_000
  const provider = vi.fn(async () => ({ reconciled: true }))
  const result = await processOutboxJobById({
    correlationIdFactory: correlationSequence(),
    cryptoContext: fixture.cryptoContext,
    db: env.DB,
    dispatch: (input) => handlers.dispatchOutboxJob({
      ...input,
      providers: { reconcileAccessGroup: provider },
    }),
    idFactory: sequence('published_id'),
    jobId: fixture.built.ids.reconcileJobId,
    leaseNonceFactory: sequence('published_nonce'),
    leaseOwnerFactory: sequence('published_owner'),
    nowFactory: () => nowMs + 1,
    nowMs,
  })
  expect(result).toEqual({
    jobId: fixture.built.ids.reconcileJobId,
    result: 'succeeded',
  })
  expect(provider).toHaveBeenCalledOnce()

  const inspected = await inspectBootstrapAggregate({
    db: env.DB,
    keyring: fixture.keyring,
    nowMs: nowMs + 2,
    ownerDisplayName: fixture.input.ownerDisplayName,
    ownerEmail: fixture.input.ownerEmail,
  })
  expect(inspected).toMatchObject({
    ids: fixture.built.ids,
    kind: 'access-published',
    reconcileState: 'succeeded',
  })
  expect(Object.keys(inspected.ids).sort()).toEqual([
    'accessAuditId',
    'auditId',
    'dataKeyId',
    'emailJobId',
    'expiryJobId',
    'invitationId',
    'invitationPublishedVersionId',
    'invitationVersionId',
    'reconcileJobId',
    'staffId',
    'staffVersionId',
  ])
})
