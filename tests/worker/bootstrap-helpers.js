import { env } from 'cloudflare:workers'
import { buildBootstrapCreationBatch } from '../../scripts/bootstrap-core.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { NOW_MS } from './fixtures.js'

export const BOOTSTRAP_SCOPE = Object.freeze({
  id: 'centre_1',
  purpose: 'identity',
  type: 'staff_directory',
})

export const sequence = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

export const bootstrapInput = (suffix) => ({
  correlationId: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
  idFactory: sequence(`opaque_${suffix}`),
  keyringConfig: {
    activeBackupKekVersion: 1,
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
  },
  nowMs: NOW_MS,
  ownerDisplayName: `Alicja Testowa ${suffix}`,
  ownerEmail: `owner-${suffix}@example.test`,
  scope: BOOTSTRAP_SCOPE,
})

export const bootstrapKeyring = (suffix) => createKeyring(
  env,
  bootstrapInput(suffix).keyringConfig,
)

export const executeBootstrapBatch = (batch) => env.DB.batch(batch.map(
  ({ sql, params }) => env.DB.prepare(sql).bind(...params),
))

export const createBootstrapFixture = async (suffix) => {
  const input = bootstrapInput(suffix)
  const keyring = await bootstrapKeyring(suffix)
  const built = await buildBootstrapCreationBatch({ ...input, keyring })
  await executeBootstrapBatch(built.batch)
  const dataKey = await env.DB.prepare(
    'SELECT * FROM data_keys WHERE id=?'
  ).bind(built.ids.dataKeyId).first()
  return Object.freeze({
    built,
    cryptoContext: Object.freeze({
      dataKey,
      keyring,
      scope: BOOTSTRAP_SCOPE,
    }),
    input,
    keyring,
  })
}
