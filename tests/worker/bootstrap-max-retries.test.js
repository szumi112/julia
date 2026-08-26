import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { inspectBootstrapAggregate } from '../../scripts/bootstrap-core.js'
import * as handlers from '../../worker/jobs/handlers.js'
import { processOutboxJobById } from '../../worker/jobs/outbox.js'
import { NOW_MS } from './fixtures.js'
import { createBootstrapFixture, sequence } from './bootstrap-helpers.js'

const correlationSequence = () => {
  let count = 0
  return () => `20000000-0000-4000-8000-${String(count += 1).padStart(12, '0')}`
}

it('accepts seven canonical retries followed by exactly one successful eighth attempt', async () => {
  const fixture = await createBootstrapFixture('max_retries')
  const ids = sequence('max_retry_id')
  const owners = sequence('max_retry_owner')
  const nonces = sequence('max_retry_nonce')
  const correlations = correlationSequence()
  let calls = 0
  let nowMs = NOW_MS + 1_000
  const provider = async () => {
    calls += 1
    if (calls <= 7) {
      const error = new Error('fixed')
      error.retryable = true
      throw error
    }
    return { reconciled: true }
  }

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await processOutboxJobById({
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
    expect(result.result).toBe(attempt === 8 ? 'succeeded' : 'retry')
    if (attempt < 8) {
      const row = await env.DB.prepare(
        'SELECT scheduled_at FROM outbox_jobs WHERE id=?'
      ).bind(fixture.built.ids.reconcileJobId).first()
      nowMs = Date.parse(row.scheduled_at)
    }
  }

  expect((await env.DB.prepare(
    `SELECT attempt_number,result,error_code
     FROM outbox_attempts WHERE job_id=? ORDER BY attempt_number`
  ).bind(fixture.built.ids.reconcileJobId).all()).results).toHaveLength(8)
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
