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
  ['client_assignments', 'version'],
  ['clients', 'version'],
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
  ['specialists', 'standard_rate_grosze'],
  ['specialists', 'version'],
]

const textPrimaryKeys = [
  ['client_assignments', 'id'], ['clients', 'id'],
  ['data_keys', 'id'], ['audit_events', 'id'], ['record_versions', 'id'],
  ['staff_users', 'id'], ['staff_invitations', 'id'], ['outbox_jobs', 'id'],
  ['outbox_attempts', 'id'], ['delivery_attempts', 'id'], ['operational_actions', 'id'],
  ['scheduler_runs', 'id'], ['backup_runs', 'id'], ['system_state', 'key'],
  ['idempotency_records', 'actor_id'], ['idempotency_records', 'operation'],
  ['idempotency_records', 'idempotency_key'],
  ['specialists', 'id'],
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
    access_allowed_at: now,
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
  it('creates the approved permissive stage-A tables', async () => {
    expect(await tableNames()).toEqual([
      'audit_events',
      'backup_runs',
      'client_assignments',
      'clients',
      'data_keys',
      'delivery_attempts',
      'idempotency_records',
      'operational_actions',
      'outbox_attempts',
      'outbox_jobs',
      'record_versions',
      'scheduler_runs',
      'specialists',
      'staff_invitations',
      'staff_users',
      'system_state',
    ])
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('seeds the exact pending practitioner-directory upgrade state', async () => {
    const row = await one(
      `SELECT key,value_json,version,updated_at FROM system_state
       WHERE key='core_directory_specialist_backfill_v1'`
    )

    expect(row).toMatchObject({
      key: 'core_directory_specialist_backfill_v1',
      value_json: '{"afterStaffId":null,"createdCount":0,"processedCount":0,"status":"pending"}',
      version: 1,
    })
    expect(new Date(row.updated_at).toISOString()).toBe(row.updated_at)
  })

  it('defers the specialist-to-staff foreign key until a D1 batch completes', async () => {
    const staffId = 'stf_deferred_specialist_parent'
    const specialistId = 'sp_deferred_specialist_child'
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO specialists
         (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
         VALUES (?,?,18000,'active',1,NULL,?,?)`
      ).bind(specialistId, staffId, now, now),
      env.DB.prepare(
        `INSERT INTO staff_users
         (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
          specialist_id,version,activated_at,disabled_at,created_at,updated_at)
         VALUES (?,?, '{}','{}','coordinator','active',?,?,1,?,NULL,?,?)`
      ).bind(staffId, `${staffId}_lookup`, `${staffId}_subject`, specialistId, now, now, now),
    ])

    expect(await one(
      'SELECT id,staff_user_id FROM specialists WHERE id=?', specialistId
    )).toEqual({ id: specialistId, staff_user_id: staffId })
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('keeps stage A permissive for legacy staff writers and lifecycle mismatches', async () => {
    await insertStaff('stf_legacy_zero_profile', { role: 'coordinator' })
    expect(await one(
      "SELECT count(*) AS count FROM specialists WHERE staff_user_id='stf_legacy_zero_profile'"
    )).toEqual({ count: 0 })

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO specialists
         (id,staff_user_id,status,created_at,updated_at)
         VALUES ('sp_permissive_mismatch','stf_permissive_mismatch','pending',?,?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO staff_users
         (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
          specialist_id,version,activated_at,disabled_at,created_at,updated_at)
         VALUES ('stf_permissive_mismatch','stf_permissive_mismatch_lookup','{}','{}',
                 'coordinator','active','stf_permissive_mismatch_subject',
                 'sp_permissive_mismatch',1,?,NULL,?,?)`
      ).bind(now, now, now),
    ])
    const result = await run(
      `UPDATE specialists
       SET status='archived',archived_at=?,version=2,updated_at=?
       WHERE id='sp_permissive_mismatch'`,
      later,
      later,
    )
    expect(result.meta.changes).toBe(1)

    const staffTriggers = (await env.DB.prepare(
      "SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='staff_users'"
    ).all()).results
    expect(staffTriggers.every(({ sql }) => !/specialists|core_directory/i.test(sql))).toBe(true)
  })

  it('enforces core row checks, immutable identities, versions, indexes, and no-delete guards', async () => {
    await insertStaff('stf_core_schema', { role: 'coordinator' })
    await run(
      `INSERT INTO specialists
       (id,staff_user_id,status,created_at,updated_at)
       VALUES ('sp_core_schema','stf_core_schema','active',?,?)`,
      now,
      now,
    )
    await run(
      `INSERT INTO clients
       (id,identity_envelope,status,version,archived_at,created_at,updated_at)
       VALUES ('cl_core_schema','{}','active',1,NULL,?,?)`,
      now,
      now,
    )
    await run(
      `INSERT INTO client_assignments
       (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,version,created_at,updated_at)
       VALUES ('asg_core_schema','cl_core_schema','sp_core_schema',?,NULL,'stf_core_schema',1,?,?)`,
      now,
      now,
      now,
    )

    await expect(run(
      "UPDATE clients SET updated_at=? WHERE id='cl_core_schema'", later
    )).rejects.toThrow(/invalid_version_increment/)
    await expect(run(
      "UPDATE client_assignments SET starts_at=?,version=2,updated_at=? WHERE id='asg_core_schema'",
      later,
      later,
    )).rejects.toThrow(/immutable_assignment_identity/)
    await expect(run("DELETE FROM specialists WHERE id='sp_core_schema'"))
      .rejects.toThrow(/no_routine_delete/)
    await expect(run(
      `INSERT INTO clients
       (id,identity_envelope,status,version,archived_at,created_at,updated_at)
       VALUES ('bad_client','{}','active',1,NULL,?,?)`, now, now
    )).rejects.toThrow()
    await expect(run(
      `INSERT INTO clients
       (id,identity_envelope,status,version,archived_at,created_at,updated_at)
       VALUES ('cl_archived_without_time','{}','archived',1,NULL,?,?)`, now, now
    )).rejects.toThrow()
    await expect(run(
      `INSERT INTO client_assignments
       (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,created_at,updated_at)
       VALUES ('asg_bad_interval','cl_core_schema','sp_core_schema',?,?, 'stf_core_schema',?,?)`,
      later,
      now,
      now,
      now,
    )).rejects.toThrow()

    const indexes = (await env.DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type='index' AND name IN (
         'client_assignments_open_client_idx',
         'client_assignments_specialist_ends_client_idx',
         'specialists_status_id_idx',
         'staff_users_specialist_id_idx'
       ) ORDER BY name`
    ).all()).results.map(({ name }) => name)
    expect(indexes).toEqual([
      'client_assignments_open_client_idx',
      'client_assignments_specialist_ends_client_idx',
      'specialists_status_id_idx',
      'staff_users_specialist_id_idx',
    ])
  })

  it('rejects a specialist ID with bytes after an embedded NUL', async () => {
    await insertStaff('stf_nul_specialist', { role: 'coordinator' })

    await expect(run(
      `INSERT INTO specialists
       (id,staff_user_id,status,created_at,updated_at)
       VALUES (?,'stf_nul_specialist','active',?,?)`,
      'sp_a\0!',
      now,
      now,
    )).rejects.toThrow()
  })

  it('rejects a client ID with bytes after an embedded NUL', async () => {
    await expect(run(
      `INSERT INTO clients
       (id,identity_envelope,status,created_at,updated_at)
       VALUES (?,'{}','active',?,?)`,
      'cl_a\0!',
      now,
      now,
    )).rejects.toThrow()
  })

  it('rejects an assignment ID with bytes after an embedded NUL', async () => {
    await insertStaff('stf_nul_assignment', { role: 'coordinator' })
    await run(
      `INSERT INTO specialists
       (id,staff_user_id,status,created_at,updated_at)
       VALUES ('sp_nul_assignment','stf_nul_assignment','active',?,?)`,
      now,
      now,
    )
    await run(
      `INSERT INTO clients
       (id,identity_envelope,status,created_at,updated_at)
       VALUES ('cl_nul_assignment','{}','active',?,?)`,
      now,
      now,
    )

    await expect(run(
      `INSERT INTO client_assignments
       (id,client_id,specialist_id,starts_at,assigned_by_staff_id,created_at,updated_at)
       VALUES (?,'cl_nul_assignment','sp_nul_assignment',?,'stf_nul_assignment',?,?)`,
      'asg_a\0!',
      now,
      now,
      now,
    )).rejects.toThrow()
  })

  it('exposes the non-persisting core-directory invariant failure sink', async () => {
    expect(await one(
      'SELECT count(*) AS count FROM core_directory_invariant_failures'
    )).toEqual({ count: 0 })
    for (const failureKind of [
      'missing_profile',
      'orphan_profile',
      'pointer_mismatch',
      'status_mismatch',
      'missing_version',
      'noncontiguous_versions',
      'upgrade_incomplete',
    ]) {
      await expect(run(
        'INSERT INTO core_directory_invariant_failures (failure_kind) VALUES (?)',
        failureKind,
      )).rejects.toThrow(/core_directory_invariant_failed/)
    }
    expect(await one(
      'SELECT count(*) AS count FROM core_directory_invariant_failures'
    )).toEqual({ count: 0 })
  })

  it('seeds the canonical outbox drain heartbeat exactly once', async () => {
    const row = await one(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
    )

    expect(row).toMatchObject({
      key: 'outbox.drain.last_success',
      value_json: '{"completedAt":null}',
      version: 1,
    })
    expect(new Date(row.updated_at).toISOString()).toBe(row.updated_at)
    await expect(run(
      `INSERT INTO system_state (key,value_json,version,updated_at)
       VALUES ('outbox.drain.last_success','{"completedAt":null}',1,?)`,
      now,
    )).rejects.toThrow(/identity_collision/)
  })

  it('keeps recurring operational health lookups index-bounded', async () => {
    const cases = [
      {
        index: 'backup_runs_created_id_idx',
        sql: `SELECT id,status,completed_at,last_error_code,created_at,updated_at
              FROM backup_runs
              ORDER BY created_at DESC,id DESC LIMIT 1`,
        table: 'backup_runs',
      },
      {
        index: 'backup_runs_success_completed_id_idx',
        sql: `SELECT id,status,completed_at,last_error_code,created_at,updated_at
              FROM backup_runs INDEXED BY backup_runs_success_completed_id_idx
              WHERE status IN ('stored','restore_verified')
              ORDER BY completed_at DESC,id DESC LIMIT 1`,
        table: 'backup_runs',
      },
      {
        index: 'operational_actions_resolved_fingerprint_at_id_idx',
        sql: `SELECT id,fingerprint,kind,severity,status,entity_type,entity_id,
                    details_envelope,version,created_at,updated_at,resolved_at
              FROM operational_actions
              WHERE fingerprint='security.authorization_denials:stf_plan:staff.manage'
                AND status='resolved'
              ORDER BY resolved_at DESC,id DESC LIMIT 1`,
        table: 'operational_actions',
      },
      ...['dead', 'succeeded'].map((status) => ({
        index: 'outbox_jobs_ordinary_status_updated_id_idx',
        sql: `SELECT id,type,status,updated_at
              FROM outbox_jobs
              WHERE type IN ('staff.access.reconcile','staff.invitation.email','staff.invitation.expire')
                AND status='${status}'
              ORDER BY updated_at DESC,id DESC LIMIT 1`,
        table: 'outbox_jobs',
      })),
      {
        index: 'scheduler_runs_status_completed_id_idx',
        sql: `SELECT id,scheduled_for,completed_at,status
              FROM scheduler_runs
              WHERE status='succeeded'
              ORDER BY completed_at DESC,id DESC LIMIT 1`,
        table: 'scheduler_runs',
      },
    ]

    for (const fixture of cases) {
      let details = ''
      try {
        const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${fixture.sql}`).all()
        details = plan.results.map(({ detail }) => detail).join('\n')
      } catch {
        // A missing required index is the same failed plan contract.
      }
      expect(details, fixture.index).toContain(`USING INDEX ${fixture.index}`)
      expect(details, fixture.index).not.toContain('USE TEMP B-TREE')
      expect(details, fixture.index).not.toMatch(
        new RegExp(`(?:^|\\n)SCAN ${fixture.table}(?:$|\\n)`)
      )
    }
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

  it('exposes a dedicated non-persisting rate-limit guard failure sentinel', async () => {
    await expect(run(
      "INSERT INTO rate_limit_guard_failures (audit_id) VALUES ('aud_guard_failure')"
    )).rejects.toThrow(/rate_limit_guard_failed/)
    expect(await one(
      "SELECT count(*) AS count FROM rate_limit_guard_failures"
    )).toEqual({ count: 0 })
  })

  it('exposes a distinct non-persisting mechanical outbox guard sentinel', async () => {
    await expect(run(
      "INSERT INTO outbox_operation_guard_failures (operation_id) VALUES ('claim_guard_failure')"
    )).rejects.toThrow(/outbox_operation_guard_failed/)
    expect(await one(
      'SELECT count(*) AS count FROM outbox_operation_guard_failures'
    )).toEqual({ count: 0 })
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
    await insertInvitation('inv_graph', 'stf_graph_provisioned', 'stf_graph_inviter', { status: 'provisioning', access_allowed_at: null })
    await run("UPDATE staff_invitations SET status = 'pending', access_allowed_at = ?, version = 2, updated_at = ? WHERE id = 'inv_graph'", later, later)
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
    const idempotencyFacts = {
      request_hash: 'hash',
      resource_type: 'backup',
      resource_id: 'backup_id',
    }
    for (const field of Object.keys(idempotencyFacts)) {
      const facts = { ...idempotencyFacts, [field]: '' }
      await expect(run(
        `INSERT INTO idempotency_records
         (actor_id, operation, idempotency_key, request_hash, resource_type, resource_id,
          response_envelope, created_at, expires_at)
         VALUES (?, 'backup', ?, ?, ?, ?, '{}', ?, '2026-08-01T10:00:00.000Z')`,
        `actor_empty_${field}`, `empty_${field}`, facts.request_hash, facts.resource_type,
        facts.resource_id, now
      )).rejects.toThrow()
    }
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

  it('requires invitation access facts and only allows provisioning through pending', async () => {
    await insertStaff('stf_invitation_graph_inviter')
    await insertStaff('stf_invitation_graph_target', { role: 'coordinator', status: 'pending', access_subject: null, activated_at: null })
    await insertStaff('stf_invitation_pending_missing', { role: 'coordinator', status: 'pending', access_subject: null, activated_at: null })
    await insertStaff('stf_invitation_activated_missing', { role: 'coordinator', status: 'pending', access_subject: null, activated_at: null })
    await insertInvitation('inv_provisioning_graph', 'stf_invitation_graph_target', 'stf_invitation_graph_inviter', { status: 'provisioning', access_allowed_at: null })
    await expect(run("UPDATE staff_invitations SET status = 'activated', access_allowed_at = ?, activated_at = ?, version = 2, updated_at = ? WHERE id = 'inv_provisioning_graph'", later, later, later))
      .rejects.toThrow(/invalid_invitation_transition/)
    await expect(run("UPDATE staff_invitations SET status = 'pending', version = 2, updated_at = ? WHERE id = 'inv_provisioning_graph'", later))
      .rejects.toThrow()
    await run("UPDATE staff_invitations SET status = 'pending', access_allowed_at = ?, version = 2, updated_at = ? WHERE id = 'inv_provisioning_graph'", later, later)
    await expect(insertInvitation('inv_pending_missing', 'stf_invitation_pending_missing', 'stf_invitation_graph_inviter', { access_allowed_at: null }))
      .rejects.toThrow()
    await expect(insertInvitation('inv_activated_missing', 'stf_invitation_activated_missing', 'stf_invitation_graph_inviter', { status: 'activated', access_allowed_at: null, activated_at: later }))
      .rejects.toThrow()
  })

  it('rejects empty provider and incomplete-backup opaque references independently', async () => {
    await run("INSERT INTO outbox_jobs (id, type, aggregate_type, aggregate_id, payload_envelope, idempotency_key, status, attempt_count, max_attempts, scheduled_at, created_at, updated_at) VALUES ('job_optional_refs', 'backup.export', 'backup', 'bkp', '{}', 'optional_refs', 'queued', 0, 1, ?, ?, ?)", now, now, now)
    await expect(run("INSERT INTO outbox_attempts (id, job_id, attempt_number, started_at, provider_reference) VALUES ('attempt_empty_provider', 'job_optional_refs', 1, ?, '')", now))
      .rejects.toThrow()
    await expect(run("INSERT INTO delivery_attempts (id, outbox_job_id, provider, provider_reference, status, attempted_at) VALUES ('delivery_empty_provider', 'job_optional_refs', 'email', '', 'accepted', ?)", now))
      .rejects.toThrow()
    for (const [index, field] of ['export_bookmark', 'object_key', 'manifest_key', 'wrapped_ssec_key_b64', 'wrap_nonce_b64', 'object_etag'].entries()) {
      const day = String(1 + index).padStart(2, '0')
      await expect(run(
        `INSERT INTO backup_runs
         (id, local_day, local_month, retention_class, status, version, ${field}, created_at, updated_at)
         VALUES (?, ?, '2026-08', 'daily', 'failed', 1, '', ?, ?)`,
        `bkp_incomplete_${field}`, `2026-08-${day}`, now, now
      )).rejects.toThrow()
    }
  })

  it('permits action reopen and failed-backup cleanup but not failed retry', async () => {
    await run("INSERT INTO operational_actions (id, fingerprint, kind, severity, status, entity_type, entity_id, details_envelope, version, created_at, updated_at) VALUES ('act_reopen', 'action_reopen', 'backup_failed', 'warning', 'open', 'backup', 'bkp', '{}', 1, ?, ?)", now, now)
    await run("UPDATE operational_actions SET status = 'resolved', resolved_at = ?, version = 2, updated_at = ? WHERE id = 'act_reopen' AND version = 1", later, later)
    const reopened = await run("UPDATE operational_actions SET status = 'open', resolved_at = NULL, version = 3, updated_at = ? WHERE id = 'act_reopen' AND version = 2", later)
    expect(reopened.meta.changes).toBe(1)
    await insertBackup('bkp_failed_cleanup', { local_day: '2026-08-10', local_month: '2026-08', status: 'failed' })
    const pruned = await run("UPDATE backup_runs SET status = 'pruned', version = 2, updated_at = ? WHERE id = 'bkp_failed_cleanup' AND version = 1", later)
    expect(pruned.meta.changes).toBe(1)
    await insertBackup('bkp_failed_retry', { local_day: '2026-08-11', local_month: '2026-08', status: 'failed' })
    await expect(run("UPDATE backup_runs SET status = 'queued', version = 2, updated_at = ? WHERE id = 'bkp_failed_retry'", later))
      .rejects.toThrow(/invalid_backup_transition/)
  })

  it('allows at most one immutable delivery result per outbox send intent', async () => {
    await run(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,created_at,updated_at)
       VALUES ('job_delivery_unique','staff.invitation.email','staff_invitation',
               'inv_delivery_unique','{}','staff.invitation.email:delivery-unique',
               'queued',0,8,?,?,?)`,
      now,
      now,
      now,
    )
    await run(
      `INSERT INTO delivery_attempts
       (id,outbox_job_id,provider,provider_reference,status,error_code,attempted_at)
       VALUES ('delivery_unique_one','job_delivery_unique','scaleway_tem',
               '11111111-1111-4111-8111-111111111111','accepted',NULL,?)`,
      now,
    )
    await expect(run(
      `INSERT INTO delivery_attempts
       (id,outbox_job_id,provider,provider_reference,status,error_code,attempted_at)
       VALUES ('delivery_unique_two','job_delivery_unique','scaleway_tem',
               '22222222-2222-4222-8222-222222222222','accepted',NULL,?)`,
      later,
    )).rejects.toThrow()
    expect((await one(
      "SELECT count(*) AS count FROM delivery_attempts WHERE outbox_job_id='job_delivery_unique'"
    )).count).toBe(1)
  })
})
