import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { inspectBootstrapAggregate } from '../../scripts/bootstrap-core.js'
import * as handlers from '../../worker/jobs/handlers.js'
import { processOutboxJobById } from '../../worker/jobs/outbox.js'
import { NOW_MS } from './fixtures.js'
import { createBootstrapFixture, sequence } from './bootstrap-helpers.js'

const correlationSequence = () => {
  let count = 0
  return () => `40000000-0000-4000-8000-${String(count += 1).padStart(12, '0')}`
}

const stagedClock = (values) => {
  let last = values.at(-1)
  return () => {
    if (values.length > 0) last = values.shift()
    return last
  }
}

const processor = (fixture, overrides = {}) => processOutboxJobById({
  correlationIdFactory: overrides.correlationIdFactory ?? correlationSequence(),
  cryptoContext: fixture.cryptoContext,
  db: env.DB,
  dispatch: (input) => handlers.dispatchOutboxJob({
    ...input,
    providers: {
      reconcileAccessGroup: async () => ({ reconciled: true }),
    },
  }),
  idFactory: overrides.idFactory ?? sequence('lost_fence_id'),
  jobId: fixture.built.ids.reconcileJobId,
  leaseNonceFactory: overrides.leaseNonceFactory ?? sequence('lost_fence_nonce'),
  leaseOwnerFactory: overrides.leaseOwnerFactory ?? sequence('lost_fence_owner'),
  nowFactory: overrides.nowFactory,
  nowMs: overrides.nowMs,
})

it('CAS-releases the same Access lease after expiry and resumes from the exact target', async () => {
  const fixture = await createBootstrapFixture('access_lease_expired')
  const firstNowMs = NOW_MS + 1_000
  const ids = sequence('access_expired_id')
  const owners = sequence('access_expired_owner')
  const nonces = sequence('access_expired_nonce')
  const correlations = correlationSequence()
  await expect(processor(fixture, {
    correlationIdFactory: correlations,
    idFactory: ids,
    leaseNonceFactory: nonces,
    leaseOwnerFactory: owners,
    nowFactory: stagedClock([
      firstNowMs,
      firstNowMs + 1,
      firstNowMs + 2,
      firstNowMs + 60_000,
      firstNowMs + 60_001,
    ]),
    nowMs: firstNowMs,
  })).resolves.toMatchObject({ result: 'retry' })

  expect(await env.DB.prepare(
    `SELECT value_json,version,updated_at
     FROM system_state WHERE key='access.reconcile.lease'`
  ).first()).toEqual({
    updated_at: new Date(firstNowMs + 60_000).toISOString(),
    value_json: '{"expiresAt":null,"nonce":null,"owner":null}',
    version: 3,
  })
  await expect(inspectBootstrapAggregate({
    db: env.DB,
    keyring: fixture.keyring,
    nowMs: firstNowMs + 60_001,
    ownerDisplayName: fixture.input.ownerDisplayName,
    ownerEmail: fixture.input.ownerEmail,
  })).resolves.toMatchObject({
    kind: 'pre-reconcile',
    reconcileState: 'processing-expired',
  })

  const resumeNowMs = firstNowMs + 60_001
  await expect(processor(fixture, {
    correlationIdFactory: correlations,
    idFactory: ids,
    leaseNonceFactory: nonces,
    leaseOwnerFactory: owners,
    nowFactory: () => resumeNowMs + 1,
    nowMs: resumeNowMs,
  })).resolves.toMatchObject({ result: 'succeeded' })
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
})
