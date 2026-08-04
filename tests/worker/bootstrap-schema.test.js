import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { inspectBootstrapSchema } from '../../scripts/bootstrap-core.js'
import {
  applyCoreDirectoryStageB,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const FROZEN_CORE_DIRECTORY_TRIGGER = `CREATE TRIGGER core_directory_invariant_failure
INSTEAD OF INSERT ON core_directory_invariant_failures
BEGIN
  SELECT RAISE(ABORT, 'core_directory_invariant_failed');
END`

it('requires completed stage B before passing exact schema preflight', async () => {
  await expect(inspectBootstrapSchema(env.DB)).resolves.toEqual({
    kind: 'refused',
  })
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await expect(inspectBootstrapSchema(env.DB)).resolves.toEqual({
    kind: 'ready',
  })
  await env.DB.prepare('DROP TRIGGER core_directory_invariant_failure').run()
  await env.DB.prepare(FROZEN_CORE_DIRECTORY_TRIGGER).run()
  await expect(inspectBootstrapSchema(env.DB)).resolves.toEqual({
    kind: 'ready',
  })
  const trigger = await env.DB.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='staff_users_no_delete'"
  ).first()
  await env.DB.prepare('DROP TRIGGER staff_users_no_delete').run()
  await expect(inspectBootstrapSchema(env.DB)).resolves.toEqual({
    kind: 'refused',
  })
  await env.DB.prepare(trigger.sql).run()
})

it('refuses missing or same-name forged guard views, triggers, and required indexes', async () => {
  const cases = [
    {
      name: 'outbox_operation_guard_failures',
      type: 'view',
      replacement: `CREATE VIEW outbox_operation_guard_failures (operation_id) AS
        SELECT id FROM outbox_jobs`,
    },
    {
      name: 'rate_limit_guard_failures',
      type: 'view',
      replacement: `CREATE VIEW rate_limit_guard_failures (audit_id) AS
        SELECT id FROM audit_events`,
    },
    {
      name: 'outbox_operation_guard_failure',
      type: 'trigger',
      replacement: `CREATE TRIGGER outbox_operation_guard_failure
        INSTEAD OF INSERT ON outbox_operation_guard_failures
        BEGIN
          SELECT RAISE(ABORT, 'forged_guard');
        END`,
    },
    {
      name: 'staff_users_identity_collision',
      type: 'trigger',
      replacement: `CREATE TRIGGER staff_users_identity_collision
        BEFORE INSERT ON staff_users
        BEGIN
          SELECT RAISE(ABORT, 'identity_collision');
        END`,
    },
    {
      name: 'staff_users_version_increment',
      type: 'trigger',
      replacement: `CREATE TRIGGER staff_users_version_increment
        BEFORE UPDATE ON staff_users
        BEGIN
          SELECT RAISE(ABORT, 'invalid_version_increment');
        END`,
    },
    {
      name: 'record_versions_no_update',
      type: 'trigger',
      replacement: `CREATE TRIGGER record_versions_no_update
        BEFORE UPDATE ON record_versions
        WHEN 0
        BEGIN
          SELECT RAISE(ABORT, 'append_only');
        END`,
    },
    {
      name: 'delivery_attempts_outbox_job_id_idx',
      type: 'index',
      replacement: `CREATE INDEX delivery_attempts_outbox_job_id_idx
        ON delivery_attempts (provider)`,
    },
    {
      name: 'backup_runs_created_id_idx',
      type: 'index',
      replacement: `CREATE INDEX backup_runs_created_id_idx
        ON backup_runs (created_at ASC, id DESC)`,
    },
    {
      name: 'backup_runs_success_completed_id_idx',
      type: 'index',
      replacement: `CREATE INDEX backup_runs_success_completed_id_idx
        ON backup_runs (completed_at DESC, id DESC)
        WHERE status = 'stored'`,
    },
    {
      name: 'operational_actions_resolved_fingerprint_at_id_idx',
      type: 'index',
      replacement: `CREATE INDEX operational_actions_resolved_fingerprint_at_id_idx
        ON operational_actions (fingerprint, resolved_at ASC, id DESC)
        WHERE status = 'resolved'`,
    },
    {
      name: 'outbox_jobs_ordinary_status_updated_id_idx',
      type: 'index',
      replacement: `CREATE INDEX outbox_jobs_ordinary_status_updated_id_idx
        ON outbox_jobs (status, updated_at ASC, id DESC)
        WHERE type IN ('staff.access.reconcile', 'staff.invitation.email', 'staff.invitation.expire')`,
    },
    {
      name: 'scheduler_runs_status_completed_id_idx',
      type: 'index',
      replacement: `CREATE INDEX scheduler_runs_status_completed_id_idx
        ON scheduler_runs (status, completed_at ASC, id DESC)`,
    },
  ]

  for (const fixture of cases) {
    const original = await env.DB.prepare(
      'SELECT sql FROM sqlite_schema WHERE type=? AND name=?'
    ).bind(fixture.type, fixture.name).first()
    const dependentTrigger = fixture.type === 'view'
      ? await env.DB.prepare(
          `SELECT sql FROM sqlite_schema
           WHERE type='trigger' AND tbl_name=?`
        ).bind(fixture.name).first()
      : null
    expect(original?.sql).toBeTypeOf('string')
    await env.DB.prepare(`DROP ${fixture.type.toUpperCase()} ${fixture.name}`).run()
    await expect(inspectBootstrapSchema(env.DB), `${fixture.name}: missing`).resolves.toEqual({
      kind: 'refused',
    })
    await env.DB.prepare(fixture.replacement).run()
    await expect(inspectBootstrapSchema(env.DB), `${fixture.name}: forged`).resolves.toEqual({
      kind: 'refused',
    })
    await env.DB.prepare(`DROP ${fixture.type.toUpperCase()} ${fixture.name}`).run()
    await env.DB.prepare(original.sql).run()
    if (dependentTrigger) await env.DB.prepare(dependentTrigger.sql).run()
    await expect(inspectBootstrapSchema(env.DB), `${fixture.name}: restored`).resolves.toEqual({
      kind: 'ready',
    })
  }
})

it('refuses a same-name table whose constraints differ from the migration contract', async () => {
  const forgedDb = {
    prepare(sql) {
      const prepared = env.DB.prepare(sql)
      if (!sql.includes("WHERE type IN ('table','trigger','view')")) return prepared
      return {
        async all() {
          const result = await prepared.all()
          return {
            ...result,
            results: result.results.map((row) => row.name === 'staff_users'
              ? {
                  ...row,
                  sql: row.sql.replace(
                    "role IN ('owner', 'coordinator', 'specialist')",
                    "role IN ('owner', 'coordinator', 'specialist', 'admin')",
                  ),
                }
              : row),
          }
        },
      }
    },
  }

  await expect(inspectBootstrapSchema(forgedDb)).resolves.toEqual({
    kind: 'refused',
  })
})
