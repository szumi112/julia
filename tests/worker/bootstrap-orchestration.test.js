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

it('creates and readies the staging owner without Access calls, then no-ops', async () => {
  await ensureBootstrapStageB()
  const ids = sequence('orchestration_id')
  const owners = sequence('orchestration_owner')
  const nonces = sequence('orchestration_nonce')
  const correlations = correlationSequence()
  const nowMs = NOW_MS
  const dispatchBindings = []
  const emailProvider = vi.fn()
  const provider = vi.fn()
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
    code: 'BOOTSTRAP_COMPLETE',
    ok: true,
  })
  expect(Object.keys(first.ids).sort()).toEqual([
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
  const second = await execute()
  expect(second).toEqual({
    code: 'BOOTSTRAP_ALREADY_COMPLETE',
    ids: first.ids,
    ok: true,
  })
  expect(provider).not.toHaveBeenCalled()
  expect(emailProvider).not.toHaveBeenCalled()
  expect(dispatchBindings).toHaveLength(1)
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
