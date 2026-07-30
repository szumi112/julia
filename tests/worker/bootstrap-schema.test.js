import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { inspectBootstrapSchema } from '../../scripts/bootstrap-core.js'

it('passes exact migration/table/column/trigger/state preflight on the accepted schema', async () => {
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

it('refuses missing or same-name forged guard views, triggers, and delivery uniqueness', async () => {
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
