import assert from 'node:assert/strict'
import test from 'node:test'
import fixtureV3 from '../fixtures/backup-format-v3.json' with { type: 'json' }

import {
  backupObjectKeys,
  canonicalJson,
  createBackupManifest,
  expectedObjectMetadata,
  openBackupManifest,
  parseCanonicalManifest,
} from '../../worker/operations/backup-format.js'
import { CORE_PRE_WORKBOOK_MIGRATIONS } from '../../worker/operations/backup-recovery.js'

const derive = (seed) => Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 29) & 0xff)
const importKek = (seed) => crypto.subtle.importKey(
  'raw', derive(seed), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
)
const keyring = async () => ({
  activeBackupKekVersion: 1,
  getBackupKek: async (version) => version === 1 ? importKek(101) : null,
})

const fixtureBytes = (value) => new Uint8Array(Buffer.from(value, 'base64url'))

const facts = () => ({
  format: 'bwm-d1-sql-v3',
  backupId: 'bkp_recovery_v3_core',
  createdAt: '2026-08-27T12:34:56.789Z',
  localDay: '2026-08-27',
  localMonth: '2026-08',
  retentionClass: 'daily',
  source: {
    accountId: 'a'.repeat(32),
    appEnv: 'staging',
    dataMode: 'fictional',
    databaseId: '11111111-2222-4333-8444-555555555555',
  },
  appliedMigrations: structuredClone(CORE_PRE_WORKBOOK_MIGRATIONS),
  restoreSentinel: {
    kind: 'backup_run_v1',
    backupId: 'bkp_recovery_v3_core',
    createdAt: '2026-08-27T12:34:56.789Z',
    localDay: '2026-08-27',
    localMonth: '2026-08',
    retentionClass: 'daily',
    status: 'exporting',
    version: 2,
  },
  recoveryFacts: { kind: 'core_pre_workbook_v1' },
  plaintextSqlSha256: '7'.repeat(64),
  objectKey: 'backups/v3/2026/08/bkp_recovery_v3_core.sql',
  objectEtag: 'public-etag-v3',
  objectSize: 34567,
  atBookmark: 'public-bookmark-v3',
})

test('v3 canonical manifest binds exact recovery facts and plaintext SQL SHA-256', async () => {
  const rawSsecKey = derive(37)
  const nonce = Uint8Array.from({ length: 12 }, (_, index) => index)
  const result = await createBackupManifest({
    facts: facts(), rawSsecKey, keyring: await keyring(), nonceFactory: () => nonce,
  })
  assert.equal(result.manifest.format, 'bwm-d1-sql-v3')
  assert.deepEqual(result.manifest.recoveryFacts, { kind: 'core_pre_workbook_v1' })
  assert.equal(result.manifest.plaintextSqlSha256, '7'.repeat(64))
  assert.deepEqual(parseCanonicalManifest(result.bytes), result.manifest)
  const opened = await openBackupManifest({ bytes: result.bytes, keyring: await keyring() })
  assert.deepEqual(opened.manifest, result.manifest)
  assert.deepEqual(opened.rawSsecKey, rawSsecKey)
  assert.deepEqual(expectedObjectMetadata(result.manifest), {
    backupId: 'bkp_recovery_v3_core',
    format: 'bwm-d1-sql-v3',
    retentionClass: 'daily',
    sourceAppEnv: 'staging',
    sourceDatabaseId: '11111111-2222-4333-8444-555555555555',
  })
  assert.deepEqual(backupObjectKeys({
    backupId: 'bkp_recovery_v3_core', localMonth: '2026-08', version: 3,
  }), {
    objectKey: 'backups/v3/2026/08/bkp_recovery_v3_core.sql',
    manifestKey: 'backups/v3/2026/08/bkp_recovery_v3_core.manifest.json',
  })
})

test('canonical v3 fixture opens and recreates both recovery variants byte-for-byte', async () => {
  const ring = await keyring()
  for (const variant of Object.values(fixtureV3.variants)) {
    const bytes = fixtureBytes(variant.canonicalManifestBase64Url)
    const manifest = parseCanonicalManifest(bytes)
    assert.equal(manifest.backupId, variant.backupId)
    assert.equal(manifest.recoveryFacts.kind, variant.recoveryKind)
    assert.deepEqual(expectedObjectMetadata(manifest), variant.metadata)
    assert.deepEqual(backupObjectKeys({
      backupId: manifest.backupId,
      localMonth: manifest.localMonth,
      version: 3,
    }), variant.objectKeys)
    const opened = await openBackupManifest({ bytes, keyring: ring })
    assert.deepEqual(opened.rawSsecKey, derive(variant.rawSsecKeySeed))
    opened.rawSsecKey.fill(0)
    const { wrappedSsecKey: _wrapped, ...fixtureFacts } = manifest
    const recreated = await createBackupManifest({
      facts: structuredClone(fixtureFacts),
      rawSsecKey: derive(variant.rawSsecKeySeed),
      keyring: ring,
      nonceFactory: () => fixtureBytes(manifest.wrappedSsecKey.nonce),
    })
    assert.deepEqual(recreated.bytes, bytes)
  }
})

test('v3 rejects malformed digest, wrong migration/recovery pairing and authenticated fact tampering', async () => {
  const make = (value) => createBackupManifest({
    facts: value,
    rawSsecKey: derive(37),
    keyring: awaitKeyring,
    nonceFactory: () => new Uint8Array(12),
  })
  const awaitKeyring = await keyring()
  for (const mutate of [
    (value) => { value.plaintextSqlSha256 = 'A'.repeat(64) },
    (value) => { value.plaintextSqlSha256 = '7'.repeat(63) },
    (value) => { value.appliedMigrations.pop() },
    (value) => { value.recoveryFacts = { kind: 'workbook_roundtrip_v1' } },
    (value) => { value.recoveryFacts.extra = true },
    (value) => { value.objectSize = 0 },
  ]) {
    const value = facts()
    mutate(value)
    await assert.rejects(make(value), /BACKUP_CRYPTO_FAILED/)
  }

  const created = await createBackupManifest({
    facts: facts(), rawSsecKey: derive(37), keyring: awaitKeyring,
    nonceFactory: () => new Uint8Array(12),
  })
  for (const mutate of [
    (value) => { value.plaintextSqlSha256 = '8'.repeat(64) },
    (value) => { value.recoveryFacts.kind = 'other' },
  ]) {
    const manifest = structuredClone(created.manifest)
    mutate(manifest)
    const bytes = new TextEncoder().encode(canonicalJson(manifest))
    await assert.rejects(openBackupManifest({ bytes, keyring: awaitKeyring }), /BACKUP_MANIFEST_INVALID/)
  }
})
