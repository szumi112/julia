import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { inspectBootstrapAggregate } from '../../scripts/bootstrap-core.js'
import * as handlers from '../../worker/jobs/handlers.js'
import { processOutboxJobById } from '../../worker/jobs/outbox.js'
import { NOW_MS } from './fixtures.js'
import { createBootstrapFixture, sequence } from './bootstrap-helpers.js'

const correlationSequence = () => {
  let count = 0
  return () => `30000000-0000-4000-8000-${String(count += 1).padStart(12, '0')}`
}

it('accepts only an expired processing matrix, reaps that attempt, and publishes on attempt two', async () => {
  const fixture = await createBootstrapFixture('expired_resume')
  const startedAt = new Date(NOW_MS + 1_000).toISOString()
  const expiresAt = new Date(NOW_MS + 61_000).toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE outbox_jobs
       SET status='processing',attempt_count=1,lease_owner='expired_resume_owner',
           lease_expires_at=?,updated_at=?
       WHERE id=?`
    ).bind(expiresAt, startedAt, fixture.built.ids.reconcileJobId),
    env.DB.prepare(
      `INSERT INTO outbox_attempts
       (id,job_id,attempt_number,started_at)
       VALUES ('expired_resume_attempt',?,1,?)`
    ).bind(fixture.built.ids.reconcileJobId, startedAt),
  ])
  const nowMs = NOW_MS + 61_001
  await expect(inspectBootstrapAggregate({
    db: env.DB,
    keyring: fixture.keyring,
    nowMs,
    ownerDisplayName: fixture.input.ownerDisplayName,
    ownerEmail: fixture.input.ownerEmail,
  })).resolves.toMatchObject({
    kind: 'pre-reconcile',
    reconcileState: 'processing-expired',
  })

  await expect(processOutboxJobById({
    correlationIdFactory: correlationSequence(),
    cryptoContext: fixture.cryptoContext,
    db: env.DB,
    dispatch: (input) => handlers.dispatchOutboxJob({
      ...input,
      providers: {
        reconcileAccessGroup: async () => ({ reconciled: true }),
      },
    }),
    idFactory: sequence('expired_resume_id'),
    jobId: fixture.built.ids.reconcileJobId,
    leaseNonceFactory: sequence('expired_resume_nonce'),
    leaseOwnerFactory: sequence('expired_resume_lease'),
    nowFactory: () => nowMs + 1,
    nowMs,
  })).resolves.toMatchObject({ result: 'succeeded' })
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
