import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import {
  buildLocalSeedBatch,
  inspectLocalSeedState,
} from '../../scripts/seed-core.js'
import { createKeyring } from '../../worker/security/keyring.js'

it('refuses partial local state and the guarded batch rolls back every attempted completion', async () => {
  const keyringConfig = {
    activeBackupKekVersion: 1,
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
  }
  const keyring = await createKeyring(env, keyringConfig)
  const built = await buildLocalSeedBatch({ keyring, keyringConfig })
  await env.DB.prepare(built.batch[0].sql).bind(...built.batch[0].params).run()
  await expect(inspectLocalSeedState({
    db: env.DB,
    keyring,
  })).resolves.toEqual({ kind: 'refused' })

  await expect(env.DB.batch(built.batch.map(({ sql, params }) => (
    env.DB.prepare(sql).bind(...params)
  )))).rejects.toThrow(/outbox_operation_guard_failed/)
  expect(await env.DB.prepare('SELECT count(*) AS count FROM data_keys').first())
    .toEqual({ count: 1 })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first())
    .toEqual({ count: 0 })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM specialists').first())
    .toEqual({ count: 0 })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM record_versions').first())
    .toEqual({ count: 0 })
})
