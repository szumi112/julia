import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import {
  buildLocalSeedBatch,
  inspectLocalSeedState,
  LOCAL_SEED_MANIFEST,
  LOCAL_SEED_SNAPSHOT_QUERIES,
} from '../../scripts/seed-core.js'
import { encryptForScope } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { completeCoreDirectoryStageA } from './apply-migrations.js'

const KEYRING_CONFIG = Object.freeze({
  activeBackupKekVersion: 1,
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
})
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))

beforeAll(async () => {
  await completeCoreDirectoryStageA()
})

const snapshotDb = (captured) => {
  const descriptors = new WeakMap()
  return {
    async batch(statements) {
      return statements.map((statement) => ({
        results: structuredClone(captured[descriptors.get(statement)]),
      }))
    },
    prepare(sql) {
      const index = LOCAL_SEED_SNAPSHOT_QUERIES.indexOf(sql)
      const statement = Object.freeze({})
      descriptors.set(statement, index)
      return statement
    },
  }
}

const captureSeed = async () => {
  const keyring = await createKeyring(env, KEYRING_CONFIG)
  const built = await buildLocalSeedBatch({ keyring, keyringConfig: KEYRING_CONFIG })
  await env.DB.batch(built.batch.map(({ sql, params }) => (
    env.DB.prepare(sql).bind(...params)
  )))
  const results = await env.DB.batch(LOCAL_SEED_SNAPSHOT_QUERIES.map((sql) => (
    env.DB.prepare(sql)
  )))
  return {
    captured: results.map(({ results: rows }) => rows),
    keyring,
  }
}

const accessSubject = (hex) => new TextDecoder().decode(Uint8Array.from(
  hex.match(/../g).map((byte) => Number.parseInt(byte, 16)),
))
const accessSubjectHex = (value) => [...new TextEncoder().encode(value)]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('')
  .toUpperCase()

it('independently refuses every hostile field, plaintext, state, and cardinality mutation', async () => {
  const { captured, keyring } = await captureSeed()
  await expect(inspectLocalSeedState({
    db: snapshotDb(captured),
    keyring,
  })).resolves.toEqual({ kind: 'seeded' })

  const wrongKeyring = await createKeyring({
    BWM_BACKUP_KEK_V1: key(31),
    BWM_DATA_KEK_V1: key(32),
    BWM_LOOKUP_HMAC_V1: key(33),
  }, KEYRING_CONFIG)
  await expect(inspectLocalSeedState({
    db: snapshotDb(captured),
    keyring: wrongKeyring,
  })).resolves.toEqual({ kind: 'refused' })

  const auditIndex = LOCAL_SEED_SNAPSHOT_QUERIES.findIndex((sql) => (
    sql.includes('FROM audit_events')
  ))
  const specialistIndex = LOCAL_SEED_SNAPSHOT_QUERIES.findIndex((sql) => (
    sql.includes('FROM specialists')
  ))
  const cases = [
    ['staff ciphertext', async (rows) => {
      rows[1][0].display_name_envelope = '{"forged":true}'
    }],
    ['email lookup', async (rows) => {
      rows[1][0].email_lookup = `v1:${'A'.repeat(43)}`
    }],
    ['local Access subject', async (rows) => {
      rows[1][0].access_subject_hex = accessSubjectHex('local:wrong@example.test')
    }],
    ['decrypted version snapshot plaintext', async (rows) => {
      const raw = rows[1][0]
      const logical = {
        ...raw,
        access_subject: accessSubject(raw.access_subject_hex),
        status: 'pending',
      }
      delete logical.access_subject_hex
      const envelope = await encryptForScope(keyring, rows[0][0], {
        expectedScope: LOCAL_SEED_MANIFEST.scope,
        field: 'record_version',
        plaintext: JSON.stringify(logical),
        recordId: logical.id,
      })
      rows[2].find(({ entity_id }) => entity_id === logical.id).snapshot_envelope = (
        JSON.stringify(envelope)
      )
    }],
    ['permanent Access state', async (rows) => {
      rows[3][1].value_json = '{"generation":1}'
      rows[3][1].version = 2
      rows[3][1].updated_at = '2026-07-30T00:00:01.000Z'
    }],
    ['extra audit cardinality', async (rows) => {
      rows[auditIndex].push({
        action: 'local.seed.extra',
        actor_staff_id: null,
        correlation_id: 'local_seed_extra',
        entity_id: 'stf_local_owner',
        entity_type: 'staff_user',
        id: 'aud_local_extra',
        metadata_json: '{}',
        occurred_at: '2026-07-30T00:00:01.000Z',
        reason_envelope: null,
        result: 'success',
      })
    }],
    ['extra immutable version cardinality', async (rows) => {
      rows[2].push({
        ...rows[2][0],
        id: 'ver_local_extra',
        version: 2,
      })
    }],
    ['extra staff cardinality', async (rows) => {
      rows[1].push({
        ...rows[1][0],
        id: 'stf_local_extra',
      })
    }],
    ['missing specialist profile', async (rows) => {
      rows[specialistIndex] = []
    }],
    ['specialist status mismatch', async (rows) => {
      rows[specialistIndex][0].status = 'pending'
    }],
    ['extra specialist cardinality', async (rows) => {
      rows[specialistIndex].push({
        ...rows[specialistIndex][0],
        id: 'sp_local_extra',
      })
    }],
  ]

  for (const [label, mutate] of cases) {
    const candidate = structuredClone(captured)
    await mutate(candidate)
    await expect(inspectLocalSeedState({
      db: snapshotDb(candidate),
      keyring,
    }), label).resolves.toEqual({ kind: 'refused' })
  }
})
