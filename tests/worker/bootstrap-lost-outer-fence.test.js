import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { inspectBootstrapAggregate } from '../../scripts/bootstrap-core.js'
import * as handlers from '../../worker/jobs/handlers.js'
import { processOutboxJobById } from '../../worker/jobs/outbox.js'
import { NOW_MS } from './fixtures.js'
import { createBootstrapFixture, sequence } from './bootstrap-helpers.js'

const correlationSequence = () => {
  let count = 0
  return () => `50000000-0000-4000-8000-${String(count += 1).padStart(12, '0')}`
}

const stagedClock = (values) => {
  let last = values.at(-1)
  return () => {
    if (values.length > 0) last = values.shift()
    return last
  }
}

it('resumes a complete Access publication whose outer outbox finalization was lost', async () => {
  const fixture = await createBootstrapFixture('outer_fence_expired')
  const firstNowMs = NOW_MS + 1_000
  const ids = sequence('outer_expired_id')
  const owners = sequence('outer_expired_owner')
  const nonces = sequence('outer_expired_nonce')
  const correlations = correlationSequence()
  const process = (nowMs, nowFactory) => processOutboxJobById({
    correlationIdFactory: correlations,
    cryptoContext: fixture.cryptoContext,
    db: env.DB,
    dispatch: (input) => handlers.dispatchOutboxJob({
      ...input,
      providers: {
        reconcileAccessGroup: async () => ({ reconciled: true }),
      },
    }),
    idFactory: ids,
    jobId: fixture.built.ids.reconcileJobId,
    leaseNonceFactory: nonces,
    leaseOwnerFactory: owners,
    nowFactory,
    nowMs,
  })

  await expect(process(firstNowMs, stagedClock([
    firstNowMs,
    firstNowMs + 1,
    firstNowMs + 2,
    firstNowMs + 3,
    firstNowMs + 4,
    firstNowMs + 60_000,
  ]))).resolves.toMatchObject({ result: 'retry' })
  await expect(inspectBootstrapAggregate({
    db: env.DB,
    keyring: fixture.keyring,
    nowMs: firstNowMs + 60_001,
    ownerDisplayName: fixture.input.ownerDisplayName,
    ownerEmail: fixture.input.ownerEmail,
  })).resolves.toMatchObject({
    kind: 'access-published',
    reconcileState: 'processing-expired',
  })

  const resumeNowMs = firstNowMs + 60_001
  await expect(process(resumeNowMs, () => resumeNowMs + 1)).resolves.toMatchObject({
    result: 'succeeded',
  })
  await expect(inspectBootstrapAggregate({
    db: env.DB,
    keyring: fixture.keyring,
    nowMs: resumeNowMs + 2,
    ownerDisplayName: fixture.input.ownerDisplayName,
    ownerEmail: fixture.input.ownerEmail,
  })).resolves.toMatchObject({
    kind: 'access-published',
    reconcileState: 'succeeded',
  })
  expect((await env.DB.prepare(
    `SELECT action FROM audit_events
     WHERE action='staff.access.reconciled'`
  ).all()).results).toHaveLength(1)
  expect((await env.DB.prepare(
    `SELECT id FROM record_versions
     WHERE entity_type='staff_invitation' AND version=2`
  ).all()).results).toHaveLength(1)
  expect((await env.DB.prepare(
    `SELECT id FROM outbox_jobs
     WHERE type='staff.invitation.email'`
  ).all()).results).toHaveLength(1)
})
