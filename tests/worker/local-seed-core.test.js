import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import {
  buildLocalSeedBatch,
  inspectLocalSeedState,
  LOCAL_SEED_MANIFEST,
  serializeLocalSeedBatch,
} from '../../scripts/seed-core.js'
import { decryptForScope } from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { completeCoreDirectoryStageA } from './apply-migrations.js'

const KEYRING_CONFIG = Object.freeze({
  activeBackupKekVersion: 1,
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
})

beforeAll(async () => {
  await completeCoreDirectoryStageA()
})

it('creates and recognizes the exact encrypted deterministic local seed', async () => {
  const keyring = await createKeyring(env, KEYRING_CONFIG)
  const built = await buildLocalSeedBatch({ keyring, keyringConfig: KEYRING_CONFIG })
  expect(built.batch).toHaveLength(10)
  expect(built.batch.every(
    ({ params }) => params.every((value) => typeof value === 'string'),
  )).toBe(true)

  const sql = serializeLocalSeedBatch(built.batch)
  for (const forbidden of [
    ...LOCAL_SEED_MANIFEST.staff.flatMap(
      ({ displayName, email }) => [displayName, email],
    ),
    env.BWM_BACKUP_KEK_V1,
    env.BWM_DATA_KEK_V1,
    env.BWM_LOOKUP_HMAC_V1,
  ]) {
    expect(sql).not.toContain(forbidden)
  }
  expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/)
  expect(sql).toContain("CAST(X'")

  await env.DB.batch(built.batch.map(({ sql: statement, params }) => (
    env.DB.prepare(statement).bind(...params)
  )))
  await expect(inspectLocalSeedState({
    db: env.DB,
    keyring,
  })).resolves.toEqual({ kind: 'seeded' })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM data_keys').first())
    .toEqual({ count: 1 })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first())
    .toEqual({ count: 3 })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM record_versions').first())
    .toEqual({ count: 4 })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM specialists').first())
    .toEqual({ count: 1 })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM audit_events').first())
    .toEqual({ count: 1 })

  const specialist = await env.DB.prepare(
    "SELECT * FROM specialists WHERE id='sp_local_specialist'"
  ).first()
  expect(specialist).toEqual({
    id: 'sp_local_specialist',
    staff_user_id: 'stf_local_specialist',
    standard_rate_grosze: 18000,
    status: 'active',
    version: 1,
    archived_at: null,
    created_at: LOCAL_SEED_MANIFEST.createdAt,
    updated_at: LOCAL_SEED_MANIFEST.createdAt,
  })
  const specialistVersion = await env.DB.prepare(
    "SELECT * FROM record_versions WHERE entity_type='specialist' AND entity_id='sp_local_specialist'"
  ).first()
  expect(JSON.parse(await decryptForScope(keyring, await env.DB.prepare(
    'SELECT * FROM data_keys WHERE id=?'
  ).bind(LOCAL_SEED_MANIFEST.dataKeyId).first(), {
    expectedScope: LOCAL_SEED_MANIFEST.scope,
    recordId: specialist.id,
    field: 'record_version',
    envelope: JSON.parse(specialistVersion.snapshot_envelope),
  }))).toEqual({
    archivedAt: null,
    createdAt: LOCAL_SEED_MANIFEST.createdAt,
    id: specialist.id,
    schema: 'specialist.v1',
    staffUserId: specialist.staff_user_id,
    standardRateGrosze: 18000,
    status: 'active',
    updatedAt: LOCAL_SEED_MANIFEST.createdAt,
    version: 1,
  })

  const raw = JSON.stringify((await env.DB.prepare(
    `SELECT email_envelope,display_name_envelope,access_subject
     FROM staff_users ORDER BY id`
  ).all()).results)
  for (const { displayName, email } of LOCAL_SEED_MANIFEST.staff) {
    expect(raw).not.toContain(displayName)
    expect(raw).toContain(`local:${email}`)
  }
})

it('requires every active local-seed key version to be exactly one', async () => {
  const keyring = await createKeyring(env, KEYRING_CONFIG)
  await expect(buildLocalSeedBatch({ keyring })).rejects.toThrow(
    /^SEED_LOCAL_BUILD_INVALID$/,
  )
  await expect(buildLocalSeedBatch({
    keyring,
    keyringConfig: {
      ...KEYRING_CONFIG,
      activeDataKekVersion: 2,
    },
  })).rejects.toThrow(/^SEED_LOCAL_BUILD_INVALID$/)
})
