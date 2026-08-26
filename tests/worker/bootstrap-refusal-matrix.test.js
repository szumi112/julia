import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { inspectBootstrapAggregate } from '../../scripts/bootstrap-core.js'
import * as handlers from '../../worker/jobs/handlers.js'
import { processOutboxJobById, retryDelayMs } from '../../worker/jobs/outbox.js'
import { NOW_MS } from './fixtures.js'
import { createBootstrapFixture, sequence } from './bootstrap-helpers.js'

const AUDITS = 4
const JOBS = 5
const ATTEMPTS = 6
const STATES = 7

const correlationSequence = () => {
  let count = 0
  return () => `70000000-0000-4000-8000-${String(count += 1).padStart(12, '0')}`
}

const captureSnapshot = async (fixture, nowMs) => {
  let snapshot
  const db = {
    prepare: (sql) => env.DB.prepare(sql),
    async batch(statements) {
      snapshot = await env.DB.batch(statements)
      return snapshot
    },
  }
  await expect(inspectBootstrapAggregate({
    db,
    keyring: fixture.keyring,
    nowMs,
    ownerDisplayName: fixture.input.ownerDisplayName,
    ownerEmail: fixture.input.ownerEmail,
  })).resolves.not.toMatchObject({ kind: 'refused' })
  return structuredClone(snapshot)
}

const mutatedDb = (snapshot, mutate) => {
  const mutated = structuredClone(snapshot)
  mutate(mutated)
  return {
    prepare: (sql) => ({ sql }),
    async batch() {
      return structuredClone(mutated)
    },
  }
}

const expectRefused = (fixture, snapshot, nowMs, mutate, name) => expect(
  inspectBootstrapAggregate({
    db: mutatedDb(snapshot, mutate),
    keyring: fixture.keyring,
    nowMs,
    ownerDisplayName: fixture.input.ownerDisplayName,
    ownerEmail: fixture.input.ownerEmail,
  }),
  name,
).resolves.toEqual({ kind: 'refused' })

it('refuses one-field deviations from exact bootstrap and publication matrices', async () => {
  const fixture = await createBootstrapFixture('refusal_matrix')
  const initial = await captureSnapshot(fixture, NOW_MS)

  const initialCases = [
    ['stale expiry job timestamp', (snapshot) => {
      const expiry = snapshot[JOBS].results.find(
        ({ type }) => type === 'staff.invitation.expire',
      )
      expiry.updated_at = new Date(NOW_MS + 1).toISOString()
    }],
    ['malformed bootstrap audit ID', (snapshot) => {
      snapshot[AUDITS].results[0].id = 'bad audit id'
    }],
    ['mutually equal but malformed bootstrap correlations', (snapshot) => {
      snapshot[AUDITS].results[0].correlation_id = 'bad correlation!'
      for (const version of snapshot[3].results) {
        version.correlation_id = 'bad correlation!'
      }
    }],
    ['held Access lease', (snapshot) => {
      const lease = snapshot[STATES].results.find(
        ({ key }) => key === 'access.reconcile.lease',
      )
      lease.value_json = JSON.stringify({
        expiresAt: new Date(NOW_MS + 60_000).toISOString(),
        nonce: 'held_nonce',
        owner: 'held_owner',
      })
    }],
    ['extra immutable row', (snapshot) => {
      snapshot[AUDITS].results.push({
        ...snapshot[AUDITS].results[0],
        id: 'extra_audit',
      })
    }],
    ['swapped encrypted payloads', (snapshot) => {
      const reconcile = snapshot[JOBS].results.find(
        ({ type }) => type === 'staff.access.reconcile',
      )
      const expiry = snapshot[JOBS].results.find(
        ({ type }) => type === 'staff.invitation.expire',
      )
      ;[reconcile.payload_envelope, expiry.payload_envelope] = [
        expiry.payload_envelope,
        reconcile.payload_envelope,
      ]
    }],
    ['live outer target lease', (snapshot) => {
      const reconcile = snapshot[JOBS].results.find(
        ({ type }) => type === 'staff.access.reconcile',
      )
      const startedAt = new Date(NOW_MS + 1_000).toISOString()
      reconcile.status = 'processing'
      reconcile.attempt_count = 1
      reconcile.lease_owner = 'live_owner'
      reconcile.lease_expires_at = new Date(NOW_MS + 61_000).toISOString()
      reconcile.updated_at = startedAt
      snapshot[ATTEMPTS].results.push({
        attempt_number: 1,
        completed_at: null,
        error_code: null,
        id: 'live_attempt',
        job_id: reconcile.id,
        provider_reference: null,
        result: null,
        started_at: startedAt,
      })
    }],
  ]
  for (const [name, mutate] of initialCases) {
    await expectRefused(fixture, initial, NOW_MS + 1_001, mutate, name)
  }

  const ids = sequence('refusal_id')
  const owners = sequence('refusal_owner')
  const nonces = sequence('refusal_nonce')
  const correlations = correlationSequence()
  let nowMs = NOW_MS + 1_000
  let fail = true
  const process = () => processOutboxJobById({
    correlationIdFactory: correlations,
    cryptoContext: fixture.cryptoContext,
    db: env.DB,
    dispatch: (input) => handlers.dispatchOutboxJob({
      ...input,
      providers: {
        reconcileAccessGroup: async () => {
          if (fail) {
            const error = new Error('fixed')
            error.retryable = true
            throw error
          }
          return { reconciled: true }
        },
      },
    }),
    idFactory: ids,
    jobId: fixture.built.ids.reconcileJobId,
    leaseNonceFactory: nonces,
    leaseOwnerFactory: owners,
    nowFactory: () => nowMs + 1,
    nowMs,
  })
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    await process()
    nowMs = Date.parse((await env.DB.prepare(
      'SELECT scheduled_at FROM outbox_jobs WHERE id=?'
    ).bind(fixture.built.ids.reconcileJobId).first()).scheduled_at)
  }
  const retrySnapshot = await captureSnapshot(fixture, nowMs + 2)

  await expectRefused(fixture, retrySnapshot, nowMs + 60_001, (snapshot) => {
    const attempt = snapshot[ATTEMPTS].results.at(-1)
    const completedAt = new Date(
      Date.parse(attempt.started_at) + 60_000,
    ).toISOString()
    attempt.completed_at = completedAt
    const reconcile = snapshot[JOBS].results.find(
      ({ type }) => type === 'staff.access.reconcile',
    )
    reconcile.updated_at = completedAt
    reconcile.scheduled_at = new Date(
      Date.parse(completedAt) + retryDelayMs(attempt.attempt_number),
    ).toISOString()
  }, 'handler retry completed at lease expiry')
  await expectRefused(fixture, retrySnapshot, nowMs + 2, (snapshot) => {
    const lease = snapshot[STATES].results.find(
      ({ key }) => key === 'access.reconcile.lease',
    )
    lease.updated_at = snapshot[ATTEMPTS].results[0].started_at
  }, 'version-15 lease timestamped in attempt one')

  fail = false
  await process()
  const published = await captureSnapshot(fixture, nowMs + 2)
  const publishedCases = [
    ['wrong applied fingerprint', (snapshot) => {
      const applied = snapshot[STATES].results.find(
        ({ key }) => key === 'access.applied_generation',
      )
      applied.value_json = JSON.stringify({
        fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        generation: 1,
      })
    }],
    ['wrong released lease revision', (snapshot) => {
      const lease = snapshot[STATES].results.find(
        ({ key }) => key === 'access.reconcile.lease',
      )
      lease.version += 1
    }],
    ['historical final lease timestamp', (snapshot) => {
      const lease = snapshot[STATES].results.find(
        ({ key }) => key === 'access.reconcile.lease',
      )
      lease.updated_at = snapshot[ATTEMPTS].results[0].started_at
    }],
    ['same-attempt but pre-publication lease timestamp', (snapshot) => {
      const lease = snapshot[STATES].results.find(
        ({ key }) => key === 'access.reconcile.lease',
      )
      lease.updated_at = snapshot[ATTEMPTS].results.at(-1).started_at
    }],
    ['malformed publication correlation', (snapshot) => {
      const accessAudit = snapshot[AUDITS].results.find(
        ({ action }) => action === 'staff.access.reconciled',
      )
      accessAudit.correlation_id = 'bad correlation!'
      const version = snapshot[3].results.find(
        (row) => row.entity_type === 'staff_invitation' && row.version === 2,
      )
      version.correlation_id = 'bad correlation!'
    }],
  ]
  for (const [name, mutate] of publishedCases) {
    await expectRefused(fixture, published, nowMs + 2, mutate, name)
  }
})
