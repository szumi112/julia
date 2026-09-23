import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { advanceCoreDirectoryUpgrade } from '../../scripts/upgrade-core-directory-core.js'
import {
  RECOVERY_TABLES,
  readBackupRecoverySnapshot,
  recoveryFactsMatchMigrations,
} from '../../worker/operations/backup-recovery.js'

// Runs the backup snapshot against a database migrated like staging, so a
// query that no longer fits the live schema fails here instead of in the cron.
const db = env.BACKUP_RECOVERY_SCHEMA
const stages = [
  env.TEST_STAGE_A_MIGRATIONS, env.TEST_STAGE_B_MIGRATIONS, env.TEST_STAGE_C_MIGRATIONS,
  env.TEST_STAGE_D_MIGRATIONS, env.TEST_STAGE_E_MIGRATIONS, env.TEST_STAGE_F_MIGRATIONS,
]

beforeAll(async () => {
  await applyD1Migrations(db, env.TEST_STAGE_A_MIGRATIONS)
  await advanceCoreDirectoryUpgrade({
    correlationId: '71717171-7171-4717-8717-717171717171',
    cryptoContext: null,
    db,
    idFactory: () => 'aud_backup_recovery_schema',
    nowMs: Date.parse('2026-09-23T00:00:00.000Z'),
  })
  for (const stage of stages.slice(1)) await applyD1Migrations(db, stage)
})

describe('backup recovery snapshot on the full schema', () => {
  it('reads every migration and business-table count in one statement', async () => {
    const snapshot = await readBackupRecoverySnapshot(db)
    const expectedMigrations = stages.flat().map(({ name }) => name)
    expect(snapshot.appliedMigrations.map(({ name }) => name)).toEqual(expectedMigrations)
    expect(snapshot.recoveryFacts.kind).toBe('table_counts_v1')
    expect(Object.keys(snapshot.recoveryFacts.tableCounts)).toEqual([...RECOVERY_TABLES])
    expect(recoveryFactsMatchMigrations(snapshot.recoveryFacts, snapshot.appliedMigrations))
      .toBe(true)
  })

  it('reflects inserted business rows and stays stable between reads', async () => {
    const before = await readBackupRecoverySnapshot(db)
    expect(await readBackupRecoverySnapshot(db)).toEqual(before)
    await db.prepare(
      `INSERT INTO specialists (id,staff_user_id,display_name_envelope,standard_rate_grosze,
        status,version,archived_at,created_at,updated_at)
       VALUES (?,NULL,'{}',18000,'active',1,NULL,?,?)`,
    ).bind('sp_backup_schema', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z').run()
    const after = await readBackupRecoverySnapshot(db)
    expect(after.recoveryFacts.tableCounts.specialists)
      .toBe(before.recoveryFacts.tableCounts.specialists + 1)
  })
})
