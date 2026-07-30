import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { inspectBootstrapAggregate } from '../../scripts/bootstrap-core.js'
import * as handlers from '../../worker/jobs/handlers.js'
import { processOutboxJobById } from '../../worker/jobs/outbox.js'
import { NOW_MS } from './fixtures.js'
import { createBootstrapFixture, sequence } from './bootstrap-helpers.js'

const correlationSequence = () => {
  let count = 0
  return () => `10000000-0000-4000-8000-${String(count += 1).padStart(12, '0')}`
}

it('accepts a canonical retry-queued matrix and resumes the same reconcile job', async () => {
  const fixture = await createBootstrapFixture('retry_matrix')
  const ids = sequence('retry_matrix_id')
  const owners = sequence('retry_matrix_owner')
  const nonces = sequence('retry_matrix_nonce')
  const correlations = correlationSequence()
  let nowMs = NOW_MS + 1_000
  let fail = true
  const provider = async () => {
    if (fail) {
      const error = new Error('fixed')
      error.retryable = true
      throw error
    }
    return { reconciled: true }
  }
  const process = () => processOutboxJobById({
    correlationIdFactory: correlations,
    cryptoContext: fixture.cryptoContext,
    db: env.DB,
    dispatch: (input) => handlers.dispatchOutboxJob({
      ...input,
      providers: { reconcileAccessGroup: provider },
    }),
    idFactory: ids,
    jobId: fixture.built.ids.reconcileJobId,
    leaseNonceFactory: nonces,
    leaseOwnerFactory: owners,
    nowFactory: () => nowMs + 1,
    nowMs,
  })

  await expect(process()).resolves.toEqual({
    jobId: fixture.built.ids.reconcileJobId,
    result: 'retry',
  })
  await expect(inspectBootstrapAggregate({
    db: env.DB,
    keyring: fixture.keyring,
    nowMs: nowMs + 2,
    ownerDisplayName: fixture.input.ownerDisplayName,
    ownerEmail: fixture.input.ownerEmail,
  })).resolves.toMatchObject({
    ids: fixture.built.ids,
    kind: 'pre-reconcile',
    reconcileState: 'queued-retry',
  })

  const row = await env.DB.prepare(
    'SELECT scheduled_at FROM outbox_jobs WHERE id=?'
  ).bind(fixture.built.ids.reconcileJobId).first()
  nowMs = Date.parse(row.scheduled_at)
  fail = false
  await expect(process()).resolves.toMatchObject({ result: 'succeeded' })
  await expect(inspectBootstrapAggregate({
    db: env.DB,
    keyring: fixture.keyring,
    nowMs: nowMs + 2,
    ownerDisplayName: fixture.input.ownerDisplayName,
    ownerEmail: fixture.input.ownerEmail,
  })).resolves.toMatchObject({
    kind: 'access-published',
    reconcileState: 'succeeded',
  })
})
