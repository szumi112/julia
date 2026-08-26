import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { inspectBootstrapAggregate } from '../../scripts/bootstrap-core.js'
import * as handlers from '../../worker/jobs/handlers.js'
import { processOutboxJobById } from '../../worker/jobs/outbox.js'
import { NOW_MS } from './fixtures.js'
import { createBootstrapFixture, sequence } from './bootstrap-helpers.js'

const correlationSequence = () => {
  let count = 0
  return () => `60000000-0000-4000-8000-${String(count += 1).padStart(12, '0')}`
}

it('recognizes every canonical retry count from zero through seven before success', async () => {
  const fixture = await createBootstrapFixture('retry_counts')
  const ids = sequence('retry_counts_id')
  const owners = sequence('retry_counts_owner')
  const nonces = sequence('retry_counts_nonce')
  const correlations = correlationSequence()
  let nowMs = NOW_MS
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
  const inspect = () => inspectBootstrapAggregate({
    db: env.DB,
    keyring: fixture.keyring,
    nowMs: nowMs + 2,
    ownerDisplayName: fixture.input.ownerDisplayName,
    ownerEmail: fixture.input.ownerEmail,
  })

  for (let retries = 0; retries <= 7; retries += 1) {
    await expect(inspect()).resolves.toMatchObject({
      kind: 'pre-reconcile',
      reconcileState: retries === 0 ? 'queued-initial' : 'queued-retry',
    })
    expect(await env.DB.prepare(
      `SELECT version FROM system_state
       WHERE key='access.reconcile.lease'`
    ).first()).toEqual({ version: 1 + (2 * retries) })
    if (retries < 7) {
      if (retries === 0) nowMs = NOW_MS + 1_000
      await expect(process()).resolves.toMatchObject({ result: 'retry' })
      const row = await env.DB.prepare(
        'SELECT scheduled_at FROM outbox_jobs WHERE id=?'
      ).bind(fixture.built.ids.reconcileJobId).first()
      nowMs = Date.parse(row.scheduled_at)
    }
  }

  fail = false
  await expect(process()).resolves.toMatchObject({ result: 'succeeded' })
  await expect(inspect()).resolves.toMatchObject({
    kind: 'access-published',
    reconcileState: 'succeeded',
  })
})
