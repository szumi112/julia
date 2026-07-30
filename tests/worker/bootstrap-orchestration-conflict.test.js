import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { runBootstrapOwner } from '../../scripts/bootstrap-owner.mjs'
import { createBootstrapFixture } from './bootstrap-helpers.js'

it('refuses a conflicting owner before opaque IDs or provider I/O', async () => {
  const fixture = await createBootstrapFixture('conflicting_owner')
  const idFactory = vi.fn()
  const correlationIdFactory = vi.fn()
  const provider = vi.fn()
  const result = await runBootstrapOwner({
    argv: [],
    env: {
      APP_ENV: 'staging',
      APP_ORIGIN: 'https://staging-panel.bearwithme.pl',
      BOOTSTRAP_OWNER_DISPLAY_NAME: 'Inna Osoba',
      BOOTSTRAP_OWNER_EMAIL: 'other-owner@example.test',
      BOOTSTRAP_TARGET: 'staging',
      BWM_BACKUP_KEK_V1: env.BWM_BACKUP_KEK_V1,
      BWM_DATA_KEK_V1: env.BWM_DATA_KEK_V1,
      BWM_LOOKUP_HMAC_V1: env.BWM_LOOKUP_HMAC_V1,
      CF_ACCESS_GROUP_ID: '11111111-1111-4111-8111-111111111111',
      CF_ACCESS_GROUP_NAME: 'Bear with me - panel - staging',
      CF_ACCESS_GROUP_TOKEN: 'access-token',
      CF_ACCOUNT_ID: 'a'.repeat(32),
      CF_D1_BOOTSTRAP_TOKEN: 'd1-token',
      CF_D1_DATABASE_ID: '22222222-2222-4222-8222-222222222222',
      DATA_MODE: 'fictional',
    },
    deps: {
      correlationIdFactory,
      db: env.DB,
      idFactory,
      keyring: fixture.keyring,
      now: () => fixture.input.nowMs,
      providers: { reconcileAccessGroup: provider },
    },
  })

  expect(result).toEqual({
    code: 'BOOTSTRAP_STATE_REFUSED',
    ok: false,
  })
  expect(idFactory).not.toHaveBeenCalled()
  expect(correlationIdFactory).not.toHaveBeenCalled()
  expect(provider).not.toHaveBeenCalled()
})
