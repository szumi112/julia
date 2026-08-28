import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { pruneExpiredBackups } from '../../worker/operations/backup-retention.js'

const DAY_MS = 86_400_000
const localDay = '2044-07-01'
const expiresAt = new Date(Date.parse(`${localDay}T00:00:00.000Z`) + 35 * DAY_MS).toISOString()

async function seedStored({
  id = 'bkp_retention_daily',
  retentionClass = 'daily',
  day = localDay,
  expiry = expiresAt,
  formatVersion = 2,
  objectKeyOverride = null,
} = {}) {
  const month = day.slice(0, 7)
  const createdAt = `${day}T01:20:00.000Z`
  const objectKey = objectKeyOverride
    ?? `backups/v${formatVersion}/${month.replace('-', '/')}/${id}.sql`
  const manifestKey = `backups/v${formatVersion}/${month.replace('-', '/')}/${id}.manifest.json`
  await env.DB.prepare(
    `INSERT INTO backup_runs
     (id,local_day,local_month,retention_class,status,version,export_bookmark,
      object_key,manifest_key,ssec_key_version,wrapped_ssec_key_b64,wrap_nonce_b64,
      object_etag,object_size,started_at,completed_at,expires_at,restore_verified_at,
      last_error_code,created_at,updated_at)
     VALUES (?,?,?,?,'stored',3,'bookmark',?,?,1,'wrapped','nonce','etag',42,
             ?,?,?,NULL,NULL,?,?)`
  ).bind(
    id,
    day,
    month,
    retentionClass,
    objectKey,
    manifestKey,
    createdAt,
    createdAt,
    expiry,
    createdAt,
    createdAt,
  ).run()
  return { id, objectKey, manifestKey }
}

describe('encrypted backup retention', () => {
  it('prunes a daily backup at its 35-day expiry and records one idempotent system audit event', async () => {
    const seeded = await seedStored()
    const archive = { delete: vi.fn(async () => {}) }
    let serial = 0
    const input = (nowMs) => ({
      db: env.DB,
      archive,
      nowMs,
      limit: 20,
      idFactory: () => `audit_backup_pruned_${++serial}`,
      correlationIdFactory: () => `correlation_backup_pruned_${serial}`,
    })

    await expect(pruneExpiredBackups(input(Date.parse(expiresAt) - 1))).resolves.toEqual({
      selected: 0, pruned: 0,
    })
    expect(archive.delete).not.toHaveBeenCalled()

    await expect(pruneExpiredBackups(input(Date.parse(expiresAt)))).resolves.toEqual({
      selected: 1, pruned: 1,
    })
    expect(archive.delete.mock.calls).toEqual([
      [seeded.manifestKey],
      [seeded.objectKey],
    ])
    expect(await env.DB.prepare(
      'SELECT status,version,updated_at FROM backup_runs WHERE id=?'
    ).bind(seeded.id).first()).toEqual({
      status: 'pruned', version: 5, updated_at: expiresAt,
    })
    expect(await env.DB.prepare(
      `SELECT actor_staff_id,action,entity_type,entity_id,result,metadata_json
       FROM audit_events WHERE entity_id=?`
    ).bind(seeded.id).first()).toEqual({
      actor_staff_id: null,
      action: 'backup.pruned',
      entity_type: 'backup_run',
      entity_id: seeded.id,
      result: 'success',
      metadata_json: '{"backupVersion":5}',
    })

    await expect(pruneExpiredBackups(input(Date.parse(expiresAt) + 1))).resolves.toEqual({
      selected: 0, pruned: 0,
    })
    expect(archive.delete).toHaveBeenCalledTimes(2)
  })

  it('idempotently removes deterministic objects for a failed run older than 24 hours', async () => {
    const nowMs = Date.parse('2044-09-10T12:00:00.000Z')
    const createdAt = new Date(nowMs - 24 * 60 * 60 * 1000 - 1).toISOString()
    const backupId = 'bkp_retention_failed_incomplete'
    await env.DB.prepare(
      `INSERT INTO backup_runs
       (id,local_day,local_month,retention_class,status,version,started_at,
        last_error_code,created_at,updated_at)
       VALUES (?,'2044-09-09','2044-09','daily','failed',3,?,
               'BACKUP_CREATE_FAILED',?,?)`
    ).bind(backupId, createdAt, createdAt, createdAt).run()
    const archive = { delete: vi.fn(async () => {}) }

    await expect(pruneExpiredBackups({
      db: env.DB,
      archive,
      nowMs,
      limit: 20,
      idFactory: () => 'audit_backup_pruned_failed',
      correlationIdFactory: () => 'correlation_backup_pruned_failed',
    })).resolves.toEqual({ selected: 1, pruned: 1 })

    expect(archive.delete.mock.calls).toEqual([
      [`backups/v2/2044/09/${backupId}.manifest.json`],
      [`backups/v2/2044/09/${backupId}.sql`],
      [`backups/v1/2044/09/${backupId}.manifest.json`],
      [`backups/v1/2044/09/${backupId}.sql`],
    ])
    expect(await env.DB.prepare(
      'SELECT status,version FROM backup_runs WHERE id=?'
    ).bind(backupId).first()).toEqual({ status: 'pruned', version: 5 })
  })

  it('claims the selected backup version before deletion so restore verification cannot race pruning', async () => {
    const seeded = await seedStored({ id: 'bkp_retention_restore_race' })
    let restoreChanges = null
    const archive = {
      delete: vi.fn(async () => {
        if (restoreChanges !== null) return
        const response = await env.DB.prepare(
          `UPDATE backup_runs
           SET status='restore_verified',version=4,restore_verified_at=?,updated_at=?
           WHERE id=? AND status='stored' AND version=3`
        ).bind(expiresAt, expiresAt, seeded.id).run()
        restoreChanges = response.meta.changes
      }),
    }
    await expect(pruneExpiredBackups({
      db: env.DB,
      archive,
      nowMs: Date.parse(expiresAt),
      limit: 20,
      idFactory: () => 'audit_backup_pruned_restore_race',
      correlationIdFactory: () => 'correlation_backup_pruned_restore_race',
    })).resolves.toEqual({ selected: 1, pruned: 1 })
    expect(restoreChanges).toBe(0)
    expect(await env.DB.prepare(
      'SELECT status,version,restore_verified_at FROM backup_runs WHERE id=?'
    ).bind(seeded.id).first()).toEqual({
      status: 'pruned',
      version: 5,
      restore_verified_at: null,
    })
  })

  it('reclaims an interrupted prune claim and converges after manifest deletion can resume', async () => {
    const seeded = await seedStored({ id: 'bkp_retention_interrupted_prune' })
    const firstArchive = {
      delete: vi.fn(async () => { throw new Error('delete interruption marker') }),
    }
    const base = {
      db: env.DB,
      nowMs: Date.parse(expiresAt),
      limit: 20,
      idFactory: () => 'audit_backup_pruned_interrupted',
      correlationIdFactory: () => 'correlation_backup_pruned_interrupted',
    }
    await expect(pruneExpiredBackups({ ...base, archive: firstArchive }))
      .rejects.toThrow('delete interruption marker')
    expect(await env.DB.prepare(
      'SELECT status,version FROM backup_runs WHERE id=?'
    ).bind(seeded.id).first()).toEqual({ status: 'stored', version: 4 })

    const retryArchive = { delete: vi.fn(async () => {}) }
    await expect(pruneExpiredBackups({ ...base, archive: retryArchive }))
      .resolves.toEqual({ selected: 1, pruned: 1 })
    expect(retryArchive.delete.mock.calls).toEqual([
      [seeded.manifestKey],
      [seeded.objectKey],
    ])
    expect(await env.DB.prepare(
      'SELECT status,version FROM backup_runs WHERE id=?'
    ).bind(seeded.id).first()).toEqual({ status: 'pruned', version: 6 })
  })

  it('prunes a legacy completed pair manifest-first without crossing backup prefixes', async () => {
    const seeded = await seedStored({
      id: 'bkp_retention_legacy',
      day: '2044-07-02',
      expiry: expiresAt,
      formatVersion: 1,
    })
    const archive = { delete: vi.fn(async () => {}) }
    await expect(pruneExpiredBackups({
      db: env.DB,
      archive,
      nowMs: Date.parse(expiresAt),
      limit: 20,
      idFactory: () => 'audit_backup_pruned_legacy',
      correlationIdFactory: () => 'correlation_backup_pruned_legacy',
    })).resolves.toEqual({ selected: 1, pruned: 1 })
    expect(archive.delete.mock.calls).toEqual([
      [seeded.manifestKey],
      [seeded.objectKey],
    ])
  })

  it('refuses malformed completed object facts before touching the shared archive bucket', async () => {
    const seeded = await seedStored({
      id: 'bkp_retention_prefix_escape',
      day: '2044-07-03',
      expiry: expiresAt,
      objectKeyOverride: 'workbook-objects/v1/forbidden.bin',
    })
    const archive = { delete: vi.fn(async () => {}) }
    await expect(pruneExpiredBackups({
      db: env.DB,
      archive,
      nowMs: Date.parse(expiresAt),
      limit: 20,
      idFactory: () => 'audit_backup_pruned_escape',
      correlationIdFactory: () => 'correlation_backup_pruned_escape',
    })).rejects.toThrow('BACKUP_RETENTION_INVALID')
    expect(archive.delete).not.toHaveBeenCalled()
  })
})
