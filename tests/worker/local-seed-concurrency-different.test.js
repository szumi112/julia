import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import {
  buildLocalSeedBatch,
  inspectLocalSeedState,
} from '../../scripts/seed-core.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'

const KEYRING_CONFIG = Object.freeze({
  activeBackupKekVersion: 1,
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
})
const bindings = (offset) => ({
  BWM_BACKUP_KEK_V1: encodeBase64Url(new Uint8Array(32).fill(offset + 2)),
  BWM_DATA_KEK_V1: encodeBase64Url(new Uint8Array(32).fill(offset)),
  BWM_LOOKUP_HMAC_V1: encodeBase64Url(new Uint8Array(32).fill(offset + 1)),
})
const execute = (batch) => env.DB.batch(batch.map(({ sql, params }) => (
  env.DB.prepare(sql).bind(...params)
)))

it('allows exactly one competing different-key seed and refuses the losing key set', async () => {
  const leftKeyring = await createKeyring(bindings(41), KEYRING_CONFIG)
  const rightKeyring = await createKeyring(bindings(51), KEYRING_CONFIG)
  const [left, right] = await Promise.all([
    buildLocalSeedBatch({ keyring: leftKeyring, keyringConfig: KEYRING_CONFIG }),
    buildLocalSeedBatch({ keyring: rightKeyring, keyringConfig: KEYRING_CONFIG }),
  ])
  const outcomes = await Promise.allSettled([
    execute(left.batch),
    execute(right.batch),
  ])
  expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  const states = await Promise.all([leftKeyring, rightKeyring].map((keyring) => (
    inspectLocalSeedState({ db: env.DB, keyring })
  )))
  expect(states.filter(({ kind }) => kind === 'seeded')).toHaveLength(1)
  expect(states.filter(({ kind }) => kind === 'refused')).toHaveLength(1)
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
