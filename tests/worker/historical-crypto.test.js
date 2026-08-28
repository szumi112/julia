import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildHistoricalIdentity,
  decryptHistoricalIdentity,
  historicalIdentityLookupCandidates,
} from '../../worker/core/historical-crypto.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { completeCoreDirectoryStageA } from './apply-migrations.js'

const NOW = '2027-03-01T08:00:00.000Z'
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))

beforeAll(async () => completeCoreDirectoryStageA())

describe('historical identity crypto', () => {
  it('domain-separates person and counterparty lookups across every key version', async () => {
    const keyring = await createKeyring({
      BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V1: key(2),
      BWM_LOOKUP_HMAC_V2: key(3),
    }, { activeDataKekVersion: 1, activeLookupKeyVersion: 2 })
    const people = await historicalIdentityLookupCandidates(keyring, 'person', ' Żaneta Nowak ')
    const counterparties = await historicalIdentityLookupCandidates(
      keyring, 'counterparty', ' Żaneta Nowak ',
    )
    expect(people.map(({ version }) => version)).toEqual([2, 1])
    expect(new Set(people.map(({ digest }) => digest)).size).toBe(2)
    expect(people[0].digest).not.toBe(counterparties[0].digest)
  })

  it('encrypts identity under record-bound scopes and rejects cross-record tampering', async () => {
    const keyring = await createKeyring({
      BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V1: key(2),
    }, { activeDataKekVersion: 1, activeLookupKeyVersion: 1 })
    const prepared = await buildHistoricalIdentity(env.DB, keyring, {
      kind: 'person', id: 'hcl_crypto_one', dataKeyId: 'key_historical_crypto_one',
      name: 'Fikcyjna Osoba', createdAt: NOW,
    })
    await prepared.keyStatement.run()
    expect(prepared.identityEnvelope).not.toContain('Fikcyjna')
    await expect(decryptHistoricalIdentity(env.DB, keyring, {
      kind: 'person', id: 'hcl_crypto_one', envelope: prepared.identityEnvelope,
    })).resolves.toBe('Fikcyjna Osoba')
    await expect(decryptHistoricalIdentity(env.DB, keyring, {
      kind: 'person', id: 'hcl_crypto_two', envelope: prepared.identityEnvelope,
    })).rejects.toThrow(/CRYPTO_FAILURE/)
    await expect(decryptHistoricalIdentity(env.DB, keyring, {
      kind: 'counterparty', id: 'hcp_crypto_one', envelope: prepared.identityEnvelope,
    })).rejects.toThrow(/CRYPTO_FAILURE/)
  })
})
