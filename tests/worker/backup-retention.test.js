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
} = {}) {
  const month = day.slice(0, 7)
  const createdAt = `${day}T01:20:00.000Z`
  const objectKey = `backups/v1/${month.replace('-', '/')}/${id}.sql`
  const manifestKey = `backups/v1/${month.replace('-', '/')}/${id}.manifest.json`
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
      [seeded.objectKey],
      [seeded.manifestKey],
    ])
    expect(await env.DB.prepare(
      'SELECT status,version,updated_at FROM backup_runs WHERE id=?'
    ).bind(seeded.id).first()).toEqual({
      status: 'pruned', version: 4, updated_at: expiresAt,
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
      metadata_json: '{"backupVersion":4}',
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
      [`backups/v1/2044/09/${backupId}.sql`],
      [`backups/v1/2044/09/${backupId}.manifest.json`],
    ])
    expect(await env.DB.prepare(
      'SELECT status,version FROM backup_runs WHERE id=?'
    ).bind(backupId).first()).toEqual({ status: 'pruned', version: 4 })
  })
})
