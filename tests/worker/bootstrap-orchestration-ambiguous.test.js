import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import {
  createD1DatabaseFacade,
  runBootstrapOwner,
} from '../../scripts/bootstrap-owner.mjs'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { NOW_MS } from './fixtures.js'
import { sequence } from './bootstrap-helpers.js'

const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))

const bootstrapEnv = () => ({
  APP_ENV: 'staging',
  APP_ORIGIN: 'https://staging-panel.bearwithme.pl',
  BOOTSTRAP_OWNER_DISPLAY_NAME: 'Alicja Ambiguous',
  BOOTSTRAP_OWNER_EMAIL: 'ambiguous@example.test',
  BOOTSTRAP_TARGET: 'staging',
  BWM_BACKUP_KEK_V1: key(13),
  BWM_DATA_KEK_V1: key(11),
  BWM_LOOKUP_HMAC_V1: key(12),
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
  return () => `a0000000-0000-4000-8000-${String(count += 1).padStart(12, '0')}`
}

it('rereads exact state after an ambiguous committed creation and never resends it', async () => {
  let creationCalls = 0
  let injected = false
  const provider = vi.fn(async () => ({ reconciled: true }))
  const client = {
    async query({ sql, params }) {
      return (await env.DB.prepare(sql).bind(...params).all()).results
    },
    async batch(statements) {
      const results = await env.DB.batch(statements.map(({ sql, params }) => (
        env.DB.prepare(sql).bind(...params)
      )))
      if (!injected && statements.length === 11) {
        injected = true
        creationCalls += 1
        throw new Error('D1_REST_AMBIGUOUS')
      }
      return results.map(({ results: rows }) => rows)
    },
  }
  const db = createD1DatabaseFacade(client)

  const result = await runBootstrapOwner({
    argv: [],
    env: bootstrapEnv(),
    deps: {
      correlationIdFactory: correlationSequence(),
      db,
      idFactory: sequence('ambiguous_id'),
      leaseNonceFactory: sequence('ambiguous_nonce'),
      leaseOwnerFactory: sequence('ambiguous_owner'),
      now: () => NOW_MS,
      providers: { reconcileAccessGroup: provider },
    },
  })

  expect(result).toMatchObject({
    code: 'BOOTSTRAP_COMPLETE',
    ok: true,
  })
  expect(creationCalls).toBe(1)
  expect(provider).toHaveBeenCalledOnce()
  expect(await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first())
    .toEqual({ count: 1 })
})
