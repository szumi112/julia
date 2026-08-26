import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { runBootstrapOwner } from '../../scripts/bootstrap-owner.mjs'
import * as handlers from '../../worker/jobs/handlers.js'
import { NOW_MS } from './fixtures.js'
import { ensureBootstrapStageB, sequence } from './bootstrap-helpers.js'

const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))

const bootstrapEnv = () => ({
  APP_ENV: 'staging',
  APP_ORIGIN: 'https://staging.bearwithme-panel.app',
  BOOTSTRAP_OWNER_DISPLAY_NAME: 'Alicja Orkiestracja',
  BOOTSTRAP_OWNER_EMAIL: 'orchestration@example.test',
  BOOTSTRAP_TARGET: 'staging',
  BWM_BACKUP_KEK_V1: key(3),
  BWM_DATA_KEK_V1: key(1),
  BWM_LOOKUP_HMAC_V1: key(2),
  CF_ACCESS_GROUP_ID: '11111111-1111-4111-8111-111111111111',
  CF_ACCESS_GROUP_NAME: 'Bear with me - panel - staging',
  CF_ACCESS_GROUP_TOKEN: 'access-token',
  CF_ACCOUNT_ID: 'a'.repeat(32),
  CF_D1_BOOTSTRAP_TOKEN: 'd1-token',
  CF_D1_DATABASE_ID: '22222222-2222-4222-8222-222222222222',
  DATA_MODE: 'fictional',
})

const correlationSequence = () => {
  let count = 0
  return () => `80000000-0000-4000-8000-${String(count += 1).padStart(12, '0')}`
}

it('creates once, returns a fixed retry, resumes the same IDs, and then no-ops', async () => {
  await ensureBootstrapStageB()
  const ids = sequence('orchestration_id')
  const owners = sequence('orchestration_owner')
  const nonces = sequence('orchestration_nonce')
  const correlations = correlationSequence()
  let nowMs = NOW_MS
  let fail = true
  const dispatchBindings = []
  const emailProvider = vi.fn()
  const provider = vi.fn(async () => {
    if (fail) {
      const error = new Error('fixed')
      error.retryable = true
      throw error
    }
    return { reconciled: true }
  })
  const execute = () => runBootstrapOwner({
    argv: [],
    env: bootstrapEnv(),
    deps: {
      correlationIdFactory: correlations,
      db: env.DB,
      dispatch: (input) => {
        dispatchBindings.push(input.bindings)
        return handlers.dispatchOutboxJob(input)
      },
      idFactory: ids,
      leaseNonceFactory: nonces,
      leaseOwnerFactory: owners,
      now: () => nowMs,
      providers: {
        reconcileAccessGroup: provider,
        sendInvitationEmail: emailProvider,
      },
    },
  })

  const first = await execute()
  expect(first).toMatchObject({
    code: 'BOOTSTRAP_RETRY_REQUIRED',
    ok: false,
  })
  expect(Object.keys(first.ids).sort()).toEqual([
    'auditId',
    'dataKeyId',
    'expiryJobId',
    'invitationId',
    'invitationVersionId',
    'reconcileJobId',
    'staffId',
    'staffVersionId',
  ])
  nowMs = Date.parse((await env.DB.prepare(
    'SELECT scheduled_at FROM outbox_jobs WHERE id=?'
  ).bind(first.ids.reconcileJobId).first()).scheduled_at)
  fail = false

  const second = await execute()
  expect(second).toMatchObject({
    code: 'BOOTSTRAP_COMPLETE',
    ok: true,
  })
  expect(second.ids).toMatchObject(first.ids)
  expect(Object.keys(second.ids).sort()).toEqual([
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

  const third = await execute()
  expect(third).toEqual({
    code: 'BOOTSTRAP_ALREADY_COMPLETE',
    ids: second.ids,
    ok: true,
  })
  expect(provider).toHaveBeenCalledTimes(2)
  expect(emailProvider).not.toHaveBeenCalled()
  expect(dispatchBindings).toHaveLength(2)
  for (const bindings of dispatchBindings) {
    expect(bindings).toEqual({
      CF_ACCESS_GROUP_ID: '11111111-1111-4111-8111-111111111111',
      CF_ACCESS_GROUP_NAME: 'Bear with me - panel - staging',
      CF_ACCESS_GROUP_TOKEN: 'access-token',
      CF_ACCOUNT_ID: 'a'.repeat(32),
    })
    expect(bindings).not.toHaveProperty('CF_D1_BOOTSTRAP_TOKEN')
    expect(bindings).not.toHaveProperty('BWM_DATA_KEK_V1')
  }
})
