import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import {
  buildLocalSeedBatch,
  inspectLocalSeedState,
} from '../../scripts/seed-core.js'
import { createKeyring } from '../../worker/security/keyring.js'

const KEYRING_CONFIG = Object.freeze({
  activeBackupKekVersion: 1,
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
})
const execute = (batch) => env.DB.batch(batch.map(({ sql, params }) => (
  env.DB.prepare(sql).bind(...params)
)))

it('allows exactly one competing same-key seed batch without a partial merge', async () => {
  const keyring = await createKeyring(env, KEYRING_CONFIG)
  const [left, right] = await Promise.all([
    buildLocalSeedBatch({ keyring, keyringConfig: KEYRING_CONFIG }),
    buildLocalSeedBatch({ keyring, keyringConfig: KEYRING_CONFIG }),
  ])
  const outcomes = await Promise.allSettled([
    execute(left.batch),
    execute(right.batch),
  ])
  expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  await expect(inspectLocalSeedState({
    db: env.DB,
    keyring,
  })).resolves.toEqual({ kind: 'seeded' })
  await expect(env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM data_keys) AS data_keys,
       (SELECT count(*) FROM record_versions) AS versions,
       (SELECT count(*) FROM staff_users) AS staff`
  ).first()).resolves.toEqual({
    data_keys: 1,
    staff: 3,
    versions: 3,
  })
})
