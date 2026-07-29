import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const now = '2026-07-29T10:00:00.000Z'
const later = '2026-07-29T10:05:00.000Z'

const tableNames = async () => {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY name"
  ).all()
  return result.results.map(({ name }) => name)
}

const run = (sql, ...values) => env.DB.prepare(sql).bind(...values).run()
const one = async (sql, ...values) => (await env.DB.prepare(sql).bind(...values).first())

const strictIntegerColumns = [
  ['data_keys', 'dek_version'],
  ['data_keys', 'kek_version'],
  ['record_versions', 'version'],
  ['staff_users', 'version'],
  ['staff_invitations', 'version'],
  ['outbox_jobs', 'attempt_count'],
  ['outbox_jobs', 'max_attempts'],
  ['outbox_attempts', 'attempt_number'],
  ['operational_actions', 'version'],
  ['scheduler_runs', 'attempt_count'],
  ['scheduler_runs', 'claimed_jobs'],
  ['scheduler_runs', 'succeeded_jobs'],
  ['scheduler_runs', 'failed_jobs'],
  ['backup_runs', 'version'],
  ['backup_runs', 'ssec_key_version'],
  ['backup_runs', 'object_size'],
  ['system_state', 'version'],
]

const textPrimaryKeys = [
  ['data_keys', 'id'], ['audit_events', 'id'], ['record_versions', 'id'],
  ['staff_users', 'id'], ['staff_invitations', 'id'], ['outbox_jobs', 'id'],
  ['outbox_attempts', 'id'], ['delivery_attempts', 'id'], ['operational_actions', 'id'],
  ['scheduler_runs', 'id'], ['backup_runs', 'id'], ['system_state', 'key'],
  ['idempotency_records', 'actor_id'], ['idempotency_records', 'operation'],
  ['idempotency_records', 'idempotency_key'],
]

const insertStaff = (id, overrides = {}) => {
  const row = {
    id,
    email_lookup: `${id}_lookup`,
    email_envelope: '{}',
    display_name_envelope: '{}',
    role: 'owner',
    status: 'active',
    access_subject: `${id}_subject`,
    specialist_id: null,
    version: 1,
    activated_at: now,
    disabled_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
  return run(
    `INSERT INTO staff_users
     (id, email_lookup, email_envelope, display_name_envelope, role, status, access_subject,
      specialist_id, version, activated_at, disabled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.email_lookup, row.email_envelope, row.display_name_envelope, row.role,
    row.status, row.access_subject, row.specialist_id, row.version, row.activated_at,
    row.disabled_at, row.created_at, row.updated_at
  )
}

const insertInvitation = (id, staffId, inviterId, overrides = {}) => {
  const row = {
    email_lookup: `${id}_lookup`,
    email_envelope: '{}',
    display_name_envelope: '{}',
    role: 'coordinator',
    status: 'pending',
    expires_at: '2026-08-01T10:00:00.000Z',
    access_allowed_at: null,
    email_sent_at: null,
    activated_at: null,
    revoked_at: null,
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
  return run(
    `INSERT INTO staff_invitations
     (id, staff_id, email_lookup, email_envelope, display_name_envelope, role, status, inviter_id,
      expires_at, access_allowed_at, email_sent_at, activated_at, revoked_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, staffId, row.email_lookup, row.email_envelope, row.display_name_envelope, row.role,
    row.status, inviterId, row.expires_at, row.access_allowed_at, row.email_sent_at,
    row.activated_at, row.revoked_at, row.version, row.created_at, row.updated_at
  )
}

const insertBackup = (id, overrides = {}) => {
  const row = {
    local_day: '2026-07-29',
    local_month: '2026-07',
    retention_class: 'daily',
    status: 'queued',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
  return run(
    `INSERT INTO backup_runs
     (id, local_day, local_month, retention_class, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, row.local_day, row.local_month, row.retention_class, row.status, row.version,
    row.created_at, row.updated_at
  )
}

describe('foundation migrations', () => {
  it('creates only the approved Phase 1 tables', async () => {
    expect(await tableNames()).toEqual([
      'audit_events',
      'backup_runs',
      'data_keys',
      'delivery_attempts',
      'idempotency_records',
      'operational_actions',
      'outbox_attempts',
      'outbox_jobs',
      'record_versions',
      'scheduler_runs',
      'staff_invitations',
      'staff_users',
      'system_state',
    ])
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('declares nonempty text primary keys and strict integer contracts', async () => {
    for (const [table, column] of textPrimaryKeys) {
      const columns = (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results
      expect(columns.find((entry) => entry.name === column)).toMatchObject({ notnull: 1 })
      const schema = (await one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)).sql
      expect(schema).toContain(`CHECK (length(${column}) > 0)`)
    }
    for (const [table, column] of strictIntegerColumns) {
      const schema = (await one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)).sql
      expect(schema).toContain(`typeof(${column}) = 'integer'`)
    }
  })

  it('rejects mutation, deletion, and replacement of append-only history', async () => {
    await run(
      `INSERT INTO audit_events
       (id, occurred_at, action, entity_type, entity_id, result, correlation_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'aud_history', now, 'system.test', 'system', 'sys_history', 'success', 'corr_history', '{}'
    )
    await run(
      `INSERT INTO record_versions
       (id, entity_type, entity_id, version, snapshot_envelope, changed_at, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'rev_history', 'system', 'sys_history', 1, '{}', now, 'corr_history'
    )

    await expect(run("UPDATE audit_events SET result = 'failure' WHERE id = 'aud_history'"))
      .rejects.toThrow(/append_only/)
    await expect(run("DELETE FROM audit_events WHERE id = 'aud_history'"))
      .rejects.toThrow(/append_only/)
    await expect(run("INSERT OR REPLACE INTO audit_events (id, occurred_at, action, entity_type, entity_id, result, correlation_id, metadata_json) VALUES ('aud_history', ?, 'replacement', 'system', 'sys_history', 'success', 'corr_history', '{}')", later))
      .rejects.toThrow(/identity_collision/)
    await expect(run("INSERT OR REPLACE INTO record_versions (id, entity_type, entity_id, version, snapshot_envelope, changed_at, correlation_id) VALUES ('rev_other', 'system', 'sys_history', 1, '{}', ?, 'corr_history')", later))
      .rejects.toThrow(/identity_collision/)
  })

  it('enforces text identifiers, integer affinity, and foreign keys', async () => {
    await expect(run(
      `INSERT INTO data_keys (id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64, wrap_nonce_b64, kek_version, created_at)
       VALUES (NULL, 'staff', 'directory', 'directory', 1, 'wrapped', 'nonce', 1, ?)`, now
    )).rejects.toThrow()
    await expect(run(
      `INSERT INTO data_keys (id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64, wrap_nonce_b64, kek_version, created_at)
       VALUES ('', 'staff', 'directory', 'directory', 1, 'wrapped', 'nonce', 1, ?)`, now
    )).rejects.toThrow()
    await expect(run(
      `INSERT INTO data_keys (id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64, wrap_nonce_b64, kek_version, created_at)
       VALUES ('key_fractional', 'staff', 'directory', 'directory', 1.5, 'wrapped', 'nonce', 1, ?)`, now
    )).rejects.toThrow()
    await expect(run(
      `INSERT INTO audit_events (id, occurred_at, actor_staff_id, action, entity_type, entity_id, result, correlation_id, metadata_json)
       VALUES ('aud_bad_fk', ?, 'missing_staff', 'system.test', 'system', 'sys', 'success', 'corr', '{}')`, now
    )).rejects.toThrow()
    await expect(run(
      `INSERT INTO record_versions (id, entity_type, entity_id, version, snapshot_envelope, changed_by_staff_id, changed_at, correlation_id)
       VALUES ('rev_bad_fk', 'system', 'sys', 1, '{}', 'missing_staff', ?, 'corr')`, now
    )).rejects.toThrow()
  })

  it('protects data-key identity while permitting only complete monotonic rewraps', async () => {
    await run(
      `INSERT INTO data_keys (id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64, wrap_nonce_b64, kek_version, created_at)
       VALUES ('key_rewrap', 'staff', 'directory', 'directory', 1, 'wrapped_one', 'nonce_one', 1, ?)`, now
    )
    await expect(run("UPDATE data_keys SET scope_id = 'other' WHERE id = 'key_rewrap'"))
      .rejects.toThrow(/immutable_key_identity/)
    await expect(run("UPDATE data_keys SET wrapped_key_b64 = 'wrapped_two' WHERE id = 'key_rewrap'"))
      .rejects.toThrow(/invalid_key_rewrap/)
    await expect(run("UPDATE data_keys SET wrapped_key_b64 = 'wrapped_two', wrap_nonce_b64 = 'nonce_two', kek_version = 1 WHERE id = 'key_rewrap'"))
      .rejects.toThrow(/invalid_key_rewrap/)
    await run("UPDATE data_keys SET wrapped_key_b64 = 'wrapped_two', wrap_nonce_b64 = 'nonce_two', kek_version = 2, retired_at = ? WHERE id = 'key_rewrap'", later)
    expect(await one('SELECT wrapped_key_b64, wrap_nonce_b64, kek_version, retired_at FROM data_keys WHERE id = ?', 'key_rewrap'))
      .toEqual({ wrapped_key_b64: 'wrapped_two', wrap_nonce_b64: 'nonce_two', kek_version: 2, retired_at: later })
    await expect(run("UPDATE data_keys SET retired_at = NULL WHERE id = 'key_rewrap'"))
      .rejects.toThrow(/immutable_retirement/)
    await expect(run("UPDATE data_keys SET retired_at = '2026-07-29T10:10:00.000Z' WHERE id = 'key_rewrap'"))
      .rejects.toThrow(/immutable_retirement/)
    await run("UPDATE data_keys SET wrapped_key_b64 = 'wrapped_three', wrap_nonce_b64 = 'nonce_three', kek_version = 3 WHERE id = 'key_rewrap'")
    await expect(run("DELETE FROM data_keys WHERE id = 'key_rewrap'"))
      .rejects.toThrow(/no_routine_delete/)
    await expect(run("INSERT OR REPLACE INTO data_keys (id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64, wrap_nonce_b64, kek_version, created_at) VALUES ('key_rewrap', 'staff', 'other', 'directory', 1, 'x', 'y', 1, ?)", later))
      .rejects.toThrow(/identity_collision/)
  })

  it('enforces staff identity, lifecycle, owner protection, and optimistic versions', async () => {
    await expect(run(
      `INSERT INTO staff_users
       (id, email_lookup, email_envelope, display_name_envelope, role, status, version, created_at, updated_at)
       VALUES ('stf_bad_role', 'bad_role', '{}', '{}', 'admin', 'active', 1, ?, ?)`, now, now
    )).rejects.toThrow()
    await expect(run(
      `INSERT INTO staff_users
       (id, email_lookup, email_envelope, display_name_envelope, role, status, version, created_at, updated_at)
       VALUES ('stf_fractional', 'fractional', '{}', '{}', 'owner', 'pending', 1.5, ?, ?)`, now, now
    )).rejects.toThrow()
    await insertStaff('stf_owner_one')
    await insertStaff('stf_owner_two')
    await run("UPDATE staff_users SET status = 'disabled', disabled_at = ?, version = 2, updated_at = ? WHERE id = 'stf_owner_two'", later, later)
    await expect(run("UPDATE staff_users SET status = 'disabled', disabled_at = ?, version = 2, updated_at = ? WHERE id = 'stf_owner_one'", later, later))
      .rejects.toThrow(/last_active_owner/)
    await expect(run("UPDATE staff_users SET updated_at = ? WHERE id = 'stf_owner_one'", later))
      .rejects.toThrow(/invalid_version_increment/)
    await expect(run("UPDATE staff_users SET updated_at = ?, version = 3 WHERE id = 'stf_owner_one'", later))
      .rejects.toThrow(/invalid_version_increment/)
    const winner = await run("UPDATE staff_users SET updated_at = ?, version = 2 WHERE id = 'stf_owner_one' AND version = 1", later)
    const loser = await run("UPDATE staff_users SET updated_at = ?, version = 3 WHERE id = 'stf_owner_one' AND version = 1", later)
    expect(winner.meta.changes).toBe(1)
    expect(loser.meta.changes).toBe(0)
    await expect(run("DELETE FROM staff_users WHERE id = 'stf_owner_one'"))
      .rejects.toThrow(/no_routine_delete/)
    await expect(run("INSERT OR REPLACE INTO staff_users (id, email_lookup, email_envelope, display_name_envelope, role, status, access_subject, version, activated_at, created_at, updated_at) VALUES ('stf_owner_one', 'replacement', '{}', '{}', 'owner', 'active', 'replacement_subject', 1, ?, ?, ?)", now, now, now))
      .rejects.toThrow(/identity_collision/)
    await insertStaff('stf_replace_victim', { role: 'coordinator' })
    await insertStaff('stf_replace_source', { role: 'coordinator' })
    await expect(run("UPDATE OR REPLACE staff_users SET email_lookup = 'stf_replace_victim_lookup', version = 2, updated_at = ? WHERE id = 'stf_replace_source'", later))
      .rejects.toThrow(/identity_collision/)
    expect(await one("SELECT id FROM staff_users WHERE id = 'stf_replace_victim'")).toEqual({ id: 'stf_replace_victim' })
    await expect(run("UPDATE OR REPLACE staff_users SET email_lookup = 'stf_owner_one_lookup', version = 2, updated_at = ? WHERE id = 'stf_replace_source'", later))
      .rejects.toThrow(/identity_collision/)
    expect(await one("SELECT id, role, status FROM staff_users WHERE id = 'stf_owner_one'"))
      .toEqual({ id: 'stf_owner_one', role: 'owner', status: 'active' })
    await expect(run("UPDATE OR REPLACE staff_users SET status = 'disabled', disabled_at = ?, version = 3, updated_at = ? WHERE id = 'stf_owner_one'", later, later))
      .rejects.toThrow(/last_active_owner/)
  })

  it('enforces invitation lifecycle, uniqueness, versioning, and identity retention', async () => {
    await insertStaff('stf_inviter')
    await insertStaff('stf_invitee', { role: 'coordinator', email_lookup: 'invitee_lookup' })
    await insertStaff('stf_invitee_two', { role: 'coordinator', email_lookup: 'invitee_two_lookup' })
    await insertInvitation('inv_open', 'stf_invitee', 'stf_inviter', { email_lookup: 'duplicate_open_lookup' })
    await expect(insertInvitation('inv_duplicate_email', 'stf_invitee_two', 'stf_inviter', { email_lookup: 'duplicate_open_lookup' }))
      .rejects.toThrow()
    await expect(insertInvitation('inv_duplicate_staff', 'stf_invitee', 'stf_inviter', { email_lookup: 'unique_open_lookup' }))
      .rejects.toThrow()
    await expect(run("UPDATE staff_invitations SET updated_at = ? WHERE id = 'inv_open'", later))
      .rejects.toThrow(/invalid_version_increment/)
    await expect(run("UPDATE staff_invitations SET status = 'revoked', revoked_at = ?, version = 3, updated_at = ? WHERE id = 'inv_open'", later, later))
      .rejects.toThrow(/invalid_version_increment/)
    await run("UPDATE staff_invitations SET status = 'revoked', revoked_at = ?, version = 2, updated_at = ? WHERE id = 'inv_open'", later, later)
    const invitationLoser = await run("UPDATE staff_invitations SET version = 3, updated_at = ? WHERE id = 'inv_open' AND version = 1", later)
    expect(invitationLoser.meta.changes).toBe(0)
    await expect(run("DELETE FROM staff_invitations WHERE id = 'inv_open'"))
      .rejects.toThrow(/no_routine_delete/)
    await expect(run("INSERT OR REPLACE INTO staff_invitations (id, staff_id, email_lookup, email_envelope, display_name_envelope, role, status, inviter_id, expires_at, version, created_at, updated_at) VALUES ('inv_open', 'stf_invitee', 'replacement_lookup', '{}', '{}', 'coordinator', 'pending', 'stf_inviter', '2026-08-01T10:00:00.000Z', 1, ?, ?)", now, now))
      .rejects.toThrow(/identity_collision/)
    await insertInvitation('inv_replace_victim', 'stf_invitee_two', 'stf_inviter', { email_lookup: 'replace_invitation_lookup' })
    await insertStaff('stf_invitee_three', { role: 'coordinator' })
    await insertInvitation('inv_replace_source', 'stf_invitee_three', 'stf_inviter')
    await expect(run("UPDATE OR REPLACE staff_invitations SET email_lookup = 'replace_invitation_lookup', version = 2, updated_at = ? WHERE id = 'inv_replace_source'", later))
      .rejects.toThrow(/identity_collision/)
    expect(await one("SELECT id FROM staff_invitations WHERE id = 'inv_replace_victim'")).toEqual({ id: 'inv_replace_victim' })
  })

  it('enforces outbox leases, attempts, and retained operational histories', async () => {
    await expect(run(
      `INSERT INTO outbox_jobs (id, type, aggregate_type, aggregate_id, payload_envelope, idempotency_key, status, attempt_count, max_attempts, scheduled_at, created_at, updated_at)
       VALUES ('job_bad_status', 'backup.export', 'backup', 'bkp', '{}', 'key_bad', 'invalid', 0, 1, ?, ?, ?)`, now, now, now
    )).rejects.toThrow()
    await expect(run(
      `INSERT INTO outbox_jobs (id, type, aggregate_type, aggregate_id, payload_envelope, idempotency_key, status, attempt_count, max_attempts, scheduled_at, created_at, updated_at)
       VALUES ('job_fractional', 'backup.export', 'backup', 'bkp', '{}', 'key_fractional', 'queued', 0.5, 1, ?, ?, ?)`, now, now, now
    )).rejects.toThrow()
    await expect(run(
      `INSERT INTO outbox_jobs (id, type, aggregate_type, aggregate_id, payload_envelope, idempotency_key, status, attempt_count, max_attempts, scheduled_at, lease_owner, created_at, updated_at)
       VALUES ('job_bad_lease', 'backup.export', 'backup', 'bkp', '{}', 'key_lease', 'queued', 0, 1, ?, 'worker', ?, ?)`, now, now, now
    )).rejects.toThrow()
    await run(
      `INSERT INTO outbox_jobs (id, type, aggregate_type, aggregate_id, payload_envelope, idempotency_key, status, attempt_count, max_attempts, scheduled_at, created_at, updated_at)
       VALUES ('job_history', 'backup.export', 'backup', 'bkp', '{}', 'key_history', 'queued', 0, 1, ?, ?, ?)`, now, now, now
    )
    await expect(run("INSERT OR REPLACE INTO outbox_jobs (id, type, aggregate_type, aggregate_id, payload_envelope, idempotency_key, status, attempt_count, max_attempts, scheduled_at, created_at, updated_at) VALUES ('job_replacement', 'backup.export', 'backup', 'bkp', '{}', 'key_history', 'queued', 0, 1, ?, ?, ?)", later, later, later))
      .rejects.toThrow(/identity_collision/)
    await run("INSERT INTO outbox_jobs (id, type, aggregate_type, aggregate_id, payload_envelope, idempotency_key, status, attempt_count, max_attempts, scheduled_at, created_at, updated_at) VALUES ('job_replace_source', 'backup.export', 'backup', 'bkp', '{}', 'key_replace_source', 'queued', 0, 1, ?, ?, ?)", now, now, now)
    await expect(run("UPDATE OR REPLACE outbox_jobs SET idempotency_key = 'key_history', updated_at = ? WHERE id = 'job_replace_source'", later))
      .rejects.toThrow(/identity_collision/)
    expect(await one("SELECT id FROM outbox_jobs WHERE id = 'job_history'")).toEqual({ id: 'job_history' })
    await run("INSERT INTO outbox_jobs (id, type, aggregate_type, aggregate_id, payload_envelope, idempotency_key, status, attempt_count, max_attempts, scheduled_at, created_at, updated_at) VALUES ('job_replace_victim', 'backup.export', 'backup', 'bkp', '{}', 'key_replace_victim', 'queued', 0, 1, ?, ?, ?)", now, now, now)
    await expect(run("UPDATE OR REPLACE outbox_jobs SET id = 'job_replace_victim', type = 'new-type', idempotency_key = 'new-key', updated_at = ? WHERE id = 'job_replace_source'", later))
      .rejects.toThrow(/immutable_outbox_identity/)
    expect(await one("SELECT id FROM outbox_jobs WHERE id = 'job_replace_victim'"))
      .toEqual({ id: 'job_replace_victim' })
    await run(
      `INSERT INTO outbox_attempts (id, job_id, attempt_number, started_at)
       VALUES ('attempt_history', 'job_history', 1, ?)`, now
    )
    await run(
      `INSERT INTO delivery_attempts (id, outbox_job_id, provider, status, attempted_at)
       VALUES ('delivery_history', 'job_history', 'email', 'accepted', ?)`, now
    )
    await expect(run("DELETE FROM outbox_attempts WHERE id = 'attempt_history'"))
      .rejects.toThrow(/no_routine_delete/)
    await expect(run("INSERT OR REPLACE INTO outbox_attempts (id, job_id, attempt_number, started_at) VALUES ('attempt_replacement', 'job_history', 1, ?)", later))
      .rejects.toThrow(/identity_collision/)
    await expect(run("INSERT OR REPLACE INTO delivery_attempts (id, outbox_job_id, provider, status, attempted_at) VALUES ('delivery_history', 'job_history', 'email', 'accepted', ?)", later))
      .rejects.toThrow(/identity_collision/)
    await expect(run("INSERT INTO outbox_attempts (id, job_id, attempt_number, started_at, completed_at) VALUES ('attempt_mismatch', 'job_history', 2, ?, ?)", now, later))
      .rejects.toThrow()
    await run("INSERT INTO outbox_attempts (id, job_id, attempt_number, started_at) VALUES ('attempt_completion', 'job_history', 3, ?)", now)
    await run("UPDATE outbox_attempts SET completed_at = ?, result = 'succeeded', provider_reference = 'provider' WHERE id = 'attempt_completion'", later)
    await expect(run("UPDATE outbox_attempts SET result = 'dead' WHERE id = 'attempt_completion'"))
      .rejects.toThrow(/attempt_terminal/)
  })

  it('enforces operational action, scheduler, idempotency, and system-state versions', async () => {
    await run(
      `INSERT INTO operational_actions
       (id, fingerprint, kind, severity, status, entity_type, entity_id, details_envelope, version, created_at, updated_at)
       VALUES ('act_open', 'action_fingerprint', 'backup_failed', 'warning', 'open', 'backup', 'bkp', '{}', 1, ?, ?)`, now, now
    )
    await expect(run("UPDATE operational_actions SET status = 'resolved', resolved_at = ? WHERE id = 'act_open'", later))
      .rejects.toThrow(/invalid_version_increment/)
    await expect(run("UPDATE operational_actions SET status = 'resolved', resolved_at = ?, version = 3, updated_at = ? WHERE id = 'act_open'", later, later))
      .rejects.toThrow(/invalid_version_increment/)
    await run("UPDATE operational_actions SET status = 'resolved', resolved_at = ?, version = 2, updated_at = ? WHERE id = 'act_open' AND version = 1", later, later)
    const actionLoser = await run("UPDATE operational_actions SET version = 3, updated_at = ? WHERE id = 'act_open' AND version = 1", later)
    expect(actionLoser.meta.changes).toBe(0)
    await expect(run("INSERT OR REPLACE INTO operational_actions (id, fingerprint, kind, severity, status, entity_type, entity_id, details_envelope, version, created_at, updated_at) VALUES ('act_open', 'replacement_fingerprint', 'backup_failed', 'warning', 'open', 'backup', 'bkp', '{}', 1, ?, ?)", now, now))
      .rejects.toThrow(/identity_collision/)
    await run("INSERT INTO operational_actions (id, fingerprint, kind, severity, status, entity_type, entity_id, details_envelope, version, created_at, updated_at) VALUES ('act_replace_victim', 'action_replace_fingerprint', 'backup_failed', 'warning', 'open', 'backup', 'bkp', '{}', 1, ?, ?)", now, now)
    await run("INSERT INTO operational_actions (id, fingerprint, kind, severity, status, entity_type, entity_id, details_envelope, version, resolved_at, created_at, updated_at) VALUES ('act_replace_source', 'action_replace_fingerprint', 'backup_failed', 'warning', 'resolved', 'backup', 'bkp', '{}', 1, ?, ?, ?)", now, now, now)
    await expect(run("UPDATE OR REPLACE operational_actions SET status = 'open', resolved_at = NULL, version = 2, updated_at = ? WHERE id = 'act_replace_source'", later))
      .rejects.toThrow(/identity_collision/)
    expect(await one("SELECT id FROM operational_actions WHERE id = 'act_replace_victim'")).toEqual({ id: 'act_replace_victim' })
    await run(
      `INSERT INTO scheduler_runs
       (id, scheduled_for, started_at, status, attempt_count, lease_owner, lease_expires_at, claimed_jobs, succeeded_jobs, failed_jobs)
       VALUES ('sch_history', '2026-07-29T10:00:00.000Z', ?, 'running', 1, 'worker', '2026-07-29T10:15:00.000Z', 0, 0, 0)`, now
    )
    await expect(run("INSERT OR REPLACE INTO scheduler_runs (id, scheduled_for, started_at, status, attempt_count, lease_owner, lease_expires_at, claimed_jobs, succeeded_jobs, failed_jobs) VALUES ('sch_other', '2026-07-29T10:00:00.000Z', ?, 'running', 1, 'worker', '2026-07-29T10:15:00.000Z', 0, 0, 0)", now))
      .rejects.toThrow(/identity_collision/)
    await run("INSERT INTO scheduler_runs (id, scheduled_for, started_at, status, attempt_count, lease_owner, lease_expires_at, claimed_jobs, succeeded_jobs, failed_jobs) VALUES ('sch_replace_source', '2026-07-29T10:05:00.000Z', ?, 'running', 1, 'worker', '2026-07-29T10:20:00.000Z', 0, 0, 0)", now)
    await expect(run("UPDATE OR REPLACE scheduler_runs SET scheduled_for = '2026-07-29T10:00:00.000Z' WHERE id = 'sch_replace_source'"))
      .rejects.toThrow(/identity_collision|immutable_scheduler_identity/)
    expect(await one("SELECT id FROM scheduler_runs WHERE id = 'sch_history'")).toEqual({ id: 'sch_history' })
    await run(
      `INSERT INTO idempotency_records
       (actor_id, operation, idempotency_key, request_hash, resource_type, resource_id, response_envelope, created_at, expires_at)
       VALUES ('actor_history', 'backup', 'idempotency_history', 'hash', 'backup', 'bkp', '{}', ?, '2026-08-01T10:00:00.000Z')`, now
    )
    await expect(run("INSERT OR REPLACE INTO idempotency_records (actor_id, operation, idempotency_key, request_hash, resource_type, resource_id, response_envelope, created_at, expires_at) VALUES ('actor_history', 'backup', 'idempotency_history', 'replacement', 'backup', 'bkp', '{}', ?, '2026-08-01T10:00:00.000Z')", later))
      .rejects.toThrow(/identity_collision/)
    await run("INSERT INTO system_state (key, value_json, version, updated_at) VALUES ('health.snapshot', '{}', 1, ?)", now)
    await expect(run("UPDATE system_state SET updated_at = ? WHERE key = 'health.snapshot'", later))
      .rejects.toThrow(/invalid_version_increment/)
    await expect(run("UPDATE system_state SET value_json = '{\"ok\":true}', version = 3, updated_at = ? WHERE key = 'health.snapshot'", later))
      .rejects.toThrow(/invalid_version_increment/)
    await run("UPDATE system_state SET value_json = '{\"ok\":true}', version = 2, updated_at = ? WHERE key = 'health.snapshot' AND version = 1", later)
    const stateLoser = await run("UPDATE system_state SET value_json = '{}', version = 3, updated_at = ? WHERE key = 'health.snapshot' AND version = 1", later)
    expect(stateLoser.meta.changes).toBe(0)
    await expect(run("INSERT OR REPLACE INTO system_state (key, value_json, version, updated_at) VALUES ('health.snapshot', '{}', 1, ?)", later))
      .rejects.toThrow(/identity_collision/)
  })

  it('enforces backup state facts, compare-and-set, retries, and live slots', async () => {
    await expect(insertBackup('bkp_bad_month', { local_day: '2026-07-29', local_month: '2026-06' }))
      .rejects.toThrow()
    await expect(run(
      `INSERT INTO backup_runs
       (id, local_day, local_month, retention_class, status, version, object_key, manifest_key, ssec_key_version, wrapped_ssec_key_b64, wrap_nonce_b64, object_etag, object_size, export_bookmark, completed_at, expires_at, created_at, updated_at)
       VALUES ('bkp_bad_facts', '2026-07-28', '2026-07', 'daily', 'stored', 1, 'key', 'manifest', 1, 'wrapped', 'nonce', 'etag', 1.5, 'bookmark', ?, '2026-09-01T00:00:00.000Z', ?, ?)`, later, now, now
    )).rejects.toThrow()
    await insertBackup('bkp_failed', { local_day: '2026-07-27', status: 'failed' })
    await insertBackup('bkp_retry', { local_day: '2026-07-27', status: 'queued' })
    await insertBackup('bkp_live_day', { local_day: '2026-07-26', status: 'queued' })
    await expect(insertBackup('bkp_duplicate_day', { local_day: '2026-07-26', status: 'exporting' }))
      .rejects.toThrow()
    await insertBackup('bkp_live_month', { local_day: '2026-07-25', retention_class: 'monthly', status: 'queued' })
    await expect(insertBackup('bkp_duplicate_month', { local_day: '2026-07-24', retention_class: 'monthly', status: 'queued' }))
      .rejects.toThrow()
    await insertBackup('bkp_cas', { local_day: '2026-07-23' })
    await expect(run("UPDATE backup_runs SET status = 'exporting', updated_at = ? WHERE id = 'bkp_cas'", later))
      .rejects.toThrow(/invalid_version_increment/)
    await expect(run("UPDATE backup_runs SET status = 'exporting', version = 3, started_at = ?, updated_at = ? WHERE id = 'bkp_cas'", later, later))
      .rejects.toThrow(/invalid_version_increment/)
    const winner = await run("UPDATE backup_runs SET status = 'exporting', version = 2, started_at = ?, updated_at = ? WHERE id = 'bkp_cas' AND version = 1", later, later)
    const loser = await run("UPDATE backup_runs SET status = 'failed', version = 3, updated_at = ? WHERE id = 'bkp_cas' AND version = 1", later)
    expect(winner.meta.changes).toBe(1)
    expect(loser.meta.changes).toBe(0)
    await expect(run("INSERT OR REPLACE INTO backup_runs (id, local_day, local_month, retention_class, status, version, created_at, updated_at) VALUES ('bkp_cas', '2026-08-01', '2026-08', 'daily', 'queued', 1, ?, ?)", now, now))
      .rejects.toThrow(/identity_collision/)
    await insertBackup('bkp_replace_failed', { local_day: '2026-07-26', status: 'failed' })
    await expect(run("UPDATE OR REPLACE backup_runs SET status = 'queued', version = 2, updated_at = ? WHERE id = 'bkp_replace_failed'", later))
      .rejects.toThrow(/identity_collision|invalid_backup_transition/)
    expect(await one("SELECT id FROM backup_runs WHERE id = 'bkp_live_day'")).toEqual({ id: 'bkp_live_day' })
  })

  it('allows only the approved invitation, outbox, scheduler, and backup transitions', async () => {
    await insertStaff('stf_graph_inviter')
    await insertStaff('stf_graph_provisioned', { role: 'coordinator', status: 'pending', access_subject: null, activated_at: null })
    await insertInvitation('inv_graph', 'stf_graph_provisioned', 'stf_graph_inviter', { status: 'provisioning' })
    await run("UPDATE staff_invitations SET status = 'pending', version = 2, updated_at = ? WHERE id = 'inv_graph'", later)
    await run("UPDATE staff_invitations SET status = 'activated', activated_at = ?, version = 3, updated_at = ? WHERE id = 'inv_graph'", later, later)
    await expect(run("UPDATE staff_invitations SET status = 'revoked', activated_at = NULL, revoked_at = ?, version = 4, updated_at = ? WHERE id = 'inv_graph'", later, later))
      .rejects.toThrow(/invalid_invitation_transition/)

    await run("INSERT INTO outbox_jobs (id, type, aggregate_type, aggregate_id, payload_envelope, idempotency_key, status, attempt_count, max_attempts, scheduled_at, created_at, updated_at) VALUES ('job_graph', 'backup.export', 'backup', 'bkp', '{}', 'graph', 'queued', 0, 1, ?, ?, ?)", now, now, now)
    await run("UPDATE outbox_jobs SET status = 'processing', lease_owner = 'worker', lease_expires_at = ?, updated_at = ? WHERE id = 'job_graph'", later, later)
    await run("UPDATE outbox_jobs SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = 'job_graph'", later)
    await expect(run("UPDATE outbox_jobs SET status = 'queued', updated_at = ? WHERE id = 'job_graph'", later))
      .rejects.toThrow(/invalid_outbox_transition/)

    await run("INSERT INTO scheduler_runs (id, scheduled_for, started_at, status, attempt_count, lease_owner, lease_expires_at, claimed_jobs, succeeded_jobs, failed_jobs) VALUES ('sch_graph', '2026-07-29T11:00:00.000Z', ?, 'running', 1, 'worker', '2026-07-29T11:15:00.000Z', 0, 0, 0)", now)
    await run("UPDATE scheduler_runs SET status = 'failed', completed_at = ? WHERE id = 'sch_graph'", later)
    await run("UPDATE scheduler_runs SET status = 'running', completed_at = NULL WHERE id = 'sch_graph'")
    await run("UPDATE scheduler_runs SET status = 'succeeded', completed_at = ? WHERE id = 'sch_graph'", later)
    await expect(run("UPDATE scheduler_runs SET status = 'running', completed_at = NULL WHERE id = 'sch_graph'"))
      .rejects.toThrow(/invalid_scheduler_transition/)

    await insertBackup('bkp_graph', { local_day: '2026-07-22' })
    await run("UPDATE backup_runs SET status = 'exporting', started_at = ?, version = 2, updated_at = ? WHERE id = 'bkp_graph'", later, later)
    await run("UPDATE backup_runs SET status = 'stored', version = 3, export_bookmark = 'bookmark', object_key = 'object', manifest_key = 'manifest', ssec_key_version = 1, wrapped_ssec_key_b64 = 'wrapped', wrap_nonce_b64 = 'nonce', object_etag = 'etag', object_size = 1, completed_at = ?, expires_at = '2026-09-01T00:00:00.000Z', updated_at = ? WHERE id = 'bkp_graph'", later, later)
    await run("UPDATE backup_runs SET status = 'restore_verified', restore_verified_at = ?, version = 4, updated_at = ? WHERE id = 'bkp_graph'", later, later)
    await run("UPDATE backup_runs SET status = 'pruned', version = 5, updated_at = ? WHERE id = 'bkp_graph'", later)
    await expect(run("UPDATE backup_runs SET status = 'queued', version = 6, updated_at = ? WHERE id = 'bkp_graph'", later))
      .rejects.toThrow(/invalid_backup_transition/)
  })

  it('rejects empty optional identity, lease, idempotency, scheduler, and backup facts', async () => {
    await expect(insertStaff('stf_empty_subject', { access_subject: '' }))
      .rejects.toThrow()
    await expect(insertStaff('stf_empty_specialist', { role: 'specialist', specialist_id: '' }))
      .rejects.toThrow()
    await expect(run("INSERT INTO idempotency_records (actor_id, operation, idempotency_key, request_hash, resource_type, resource_id, response_envelope, created_at, expires_at) VALUES ('actor_empty', 'backup', 'empty', '', '', '', '{}', ?, '2026-08-01T10:00:00.000Z')", now))
      .rejects.toThrow()
    await expect(run("INSERT INTO outbox_jobs (id, type, aggregate_type, aggregate_id, payload_envelope, idempotency_key, status, attempt_count, max_attempts, scheduled_at, lease_owner, lease_expires_at, created_at, updated_at) VALUES ('job_empty_lease', 'backup.export', 'backup', 'bkp', '{}', 'empty_lease', 'processing', 0, 1, ?, '', ?, ?, ?)", now, later, now, now))
      .rejects.toThrow()
    await expect(run("INSERT INTO scheduler_runs (id, scheduled_for, started_at, status, attempt_count, lease_owner, lease_expires_at, claimed_jobs, succeeded_jobs, failed_jobs) VALUES ('sch_empty_lease', '2026-07-29T12:00:00.000Z', ?, 'running', 1, '', '2026-07-29T12:15:00.000Z', 0, 0, 0)", now))
      .rejects.toThrow()
    const storedFacts = {
      export_bookmark: 'bookmark',
      object_key: 'object',
      manifest_key: 'manifest',
      wrapped_ssec_key_b64: 'wrapped',
      wrap_nonce_b64: 'nonce',
      object_etag: 'etag',
    }
    for (const [index, field] of Object.keys(storedFacts).entries()) {
      const facts = { ...storedFacts, [field]: '' }
      const day = String(10 + index).padStart(2, '0')
      await expect(run(
        `INSERT INTO backup_runs
         (id, local_day, local_month, retention_class, status, version, export_bookmark, object_key,
          manifest_key, ssec_key_version, wrapped_ssec_key_b64, wrap_nonce_b64, object_etag,
          object_size, completed_at, expires_at, created_at, updated_at)
         VALUES (?, ?, '2026-07', 'daily', 'stored', 1, ?, ?, ?, 1, ?, ?, ?, 0, ?, '2026-09-01T00:00:00.000Z', ?, ?)`,
        `bkp_empty_${field}`, `2026-07-${day}`, facts.export_bookmark, facts.object_key,
        facts.manifest_key, facts.wrapped_ssec_key_b64, facts.wrap_nonce_b64, facts.object_etag,
        later, now, now
      )).rejects.toThrow()
    }
  })
})
