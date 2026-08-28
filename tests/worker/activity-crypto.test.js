import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ACTIVITY_GROUP_LOOKUP_DOMAIN,
  ACTIVITY_PARTICIPANT_LOOKUP_DOMAIN,
  ACTIVITY_SCOPE,
  activityIdentityLookupCandidates,
  decryptActivityField,
  decryptActivityIdentity,
  encryptActivityField,
  encryptActivityIdentity,
  loadActivityDataKey,
  openActivityPayload,
  sealActivityPayload,
} from '../../worker/core/activity-crypto.js'
import { getOrCreateDataKey } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW = '2027-03-01T08:00:00.000Z'
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
let keyring
let dataKey

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  keyring = await createKeyring({
    BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V1: key(2),
    BWM_LOOKUP_HMAC_V2: key(3),
  }, { activeDataKekVersion: 1, activeLookupKeyVersion: 2 })
  dataKey = await getOrCreateDataKey(env.DB, keyring, ACTIVITY_SCOPE, {
    id: 'key_activity_crypto', createdAt: NOW,
  })
})

describe('activity crypto boundary', () => {
  it('uses one exact centre activity scope and authenticated lookup domains', async () => {
    expect(ACTIVITY_SCOPE).toEqual({
      type: 'centre_activity', id: 'centre_1', purpose: 'activity',
    })
    expect(Object.isFrozen(ACTIVITY_SCOPE)).toBe(true)
    const participants = await activityIdentityLookupCandidates(keyring, {
      kind: 'participant', programId: 'apg_tus', value: ' Żaneta  Fikcyjna ',
    })
    const groups = await activityIdentityLookupCandidates(keyring, {
      kind: 'group', programId: 'apg_tus', value: ' Żaneta  Fikcyjna ',
    })
    const english = await activityIdentityLookupCandidates(keyring, {
      kind: 'participant', programId: 'apg_english', value: ' Żaneta  Fikcyjna ',
    })
    expect(participants.map(({ version }) => version)).toEqual([2, 1])
    expect(participants[0].domain).toBe(ACTIVITY_PARTICIPANT_LOOKUP_DOMAIN)
    expect(groups[0].domain).toBe(ACTIVITY_GROUP_LOOKUP_DOMAIN)
    expect(participants[0].digest).not.toBe(groups[0].digest)
    expect(participants[0].digest).not.toBe(english[0].digest)
  })

  it('encrypts participant and group identity without plaintext and binds kind/program/record', async () => {
    const participant = await encryptActivityIdentity(keyring, dataKey, {
      kind: 'participant', id: 'acp_crypto_one', programId: 'apg_tus',
      value: 'Ola Fikcyjna',
    })
    const group = await encryptActivityIdentity(keyring, dataKey, {
      kind: 'group', id: 'agr_crypto_one', programId: 'apg_tus', value: 'Sowy',
    })
    expect(participant).not.toContain('Ola')
    expect(group).not.toContain('Sowy')
    await expect(decryptActivityIdentity(keyring, dataKey, {
      kind: 'participant', id: 'acp_crypto_one', programId: 'apg_tus',
      envelope: participant,
    })).resolves.toBe('Ola Fikcyjna')
    await expect(decryptActivityIdentity(keyring, dataKey, {
      kind: 'group', id: 'agr_crypto_one', programId: 'apg_tus', envelope: group,
    })).resolves.toBe('Sowy')
    for (const hostile of [
      { kind: 'participant', id: 'acp_crypto_two', programId: 'apg_tus' },
      { kind: 'participant', id: 'acp_crypto_one', programId: 'apg_english' },
      { kind: 'group', id: 'agr_crypto_one', programId: 'apg_tus' },
    ]) await expect(decryptActivityIdentity(keyring, dataKey, {
      ...hostile, envelope: participant,
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
  })

  it('encrypts optional group details and class topics with record/field-bound AAD', async () => {
    const details = await encryptActivityField(keyring, dataKey, {
      kind: 'groupDetails', id: 'agr_crypto_one', value: 'Opis fikcyjnej grupy',
    })
    const topic = await encryptActivityField(keyring, dataKey, {
      kind: 'classTopic', id: 'acl_crypto_one', value: 'Współpraca',
    })
    expect(details).not.toContain('Opis fikcyjnej grupy')
    expect(topic).not.toContain('Współpraca')
    await expect(decryptActivityField(keyring, dataKey, {
      kind: 'groupDetails', id: 'agr_crypto_one', envelope: details,
    })).resolves.toBe('Opis fikcyjnej grupy')
    await expect(decryptActivityField(keyring, dataKey, {
      kind: 'classTopic', id: 'acl_crypto_one', envelope: topic,
    })).resolves.toBe('Współpraca')
    await expect(decryptActivityField(keyring, dataKey, {
      kind: 'classTopic', id: 'acl_crypto_one', envelope: details,
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
  })

  it('authenticates record-version and replay payload fields and reloads the scoped key', async () => {
    const versionEnvelope = await sealActivityPayload(keyring, dataKey, {
      recordId: 'acp_crypto_one', field: 'record_version',
      value: { schema: 'activity_participant.v1', version: 1 },
    })
    expect(versionEnvelope).not.toContain('activity_participant')
    await expect(openActivityPayload(keyring, dataKey, {
      recordId: 'acp_crypto_one', field: 'record_version', envelope: versionEnvelope,
    })).resolves.toEqual({ schema: 'activity_participant.v1', version: 1 })
    await expect(openActivityPayload(keyring, dataKey, {
      recordId: 'acp_crypto_one', field: 'request_replay', envelope: versionEnvelope,
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
    const leaderEnvelope = await sealActivityPayload(keyring, dataKey, {
      recordId: 'agl_crypto_one', field: 'record_version',
      value: { schema: 'activity_group_leader.v1', version: 1 },
    })
    await expect(openActivityPayload(keyring, dataKey, {
      recordId: 'agl_crypto_one', field: 'record_version', envelope: leaderEnvelope,
    })).resolves.toEqual({ schema: 'activity_group_leader.v1', version: 1 })
    const loaded = await loadActivityDataKey(env.DB, versionEnvelope)
    expect(loaded).toEqual(dataKey)
    await expect(loadActivityDataKey(env.DB, JSON.stringify({
      ...JSON.parse(versionEnvelope), dataKeyId: 'key_missing_activity',
    }))).rejects.toThrow(/^CRYPTO_FAILURE$/)
  })

  it('rejects extra fields, accessors, unsupported records, and plaintext control characters', async () => {
    await expect(encryptActivityIdentity(keyring, dataKey, {
      kind: 'participant', id: 'acp_crypto_bad', programId: 'apg_tus',
      value: 'Ola Fikcyjna', age: 12,
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
    await expect(encryptActivityIdentity(keyring, dataKey, {
      kind: 'participant', id: 'acp_crypto_bad', programId: 'apg_tus',
      value: 'Ola\u200b Fikcyjna',
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
    const hostile = Object.defineProperties({}, {
      kind: { enumerable: true, value: 'participant' },
      id: { enumerable: true, value: 'acp_crypto_bad' },
      programId: { enumerable: true, value: 'apg_tus' },
      value: { enumerable: true, get: () => 'Ola Fikcyjna' },
    })
    await expect(encryptActivityIdentity(keyring, dataKey, hostile))
      .rejects.toThrow(/^CRYPTO_FAILURE$/)
    await expect(sealActivityPayload(keyring, dataKey, {
      recordId: 'wbs_not_activity', field: 'record_version', value: {},
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
  })
})
