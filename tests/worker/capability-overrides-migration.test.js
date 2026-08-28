import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { selectCoreMigrationStage } from '../../scripts/core-migration-stages.js'
import { CAPABILITIES } from '../../src/capabilities.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW = '2026-08-28T10:00:00.000Z'
const LATER = '2026-08-28T10:05:00.000Z'
const LATEST = '2026-08-28T10:10:00.000Z'

const run = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).run()
const all = async (sql, ...bindings) => (
  await env.DB.prepare(sql).bind(...bindings).all()
).results

let emailCounter = 0
const insertStaff = (id, updatedAt = NOW) => run(
  `INSERT INTO staff_users
   (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
    specialist_id,version,activated_at,disabled_at,created_at,updated_at)
   VALUES (?,?, '{}','{}','owner','active',?,NULL,1,?,NULL,?,?)`,
  id,
  `authority-migration-${++emailCounter}`,
  `subject-${id}`,
  NOW,
  NOW,
  updatedAt,
)

const foreignKeys = async (table) => (await all(`PRAGMA foreign_key_list(${table})`))
  .map(({ from, on_delete: onDelete, on_update: onUpdate, table: parent, to }) => (
    `${from}->${parent}.${to}:${onUpdate}/${onDelete}`
  ))
  .sort()

const indexColumns = async (name) => (await all(`PRAGMA index_info(${name})`))
  .sort((left, right) => left.seqno - right.seqno)
  .map(({ name: column }) => column)

describe('capability override migration', () => {
  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await applyFinanceStageC()
    await applySpecialistProfilesStageD()

    const stageE = selectCoreMigrationStage(env.TEST_STAGE_E_MIGRATIONS, 'stage-e')
    const authorityMigration = stageE.find(({ name }) => (
      name === '0020_capability_overrides.sql'
    ))
    expect(authorityMigration).toBeDefined()
    await applyD1Migrations(env.DB, stageE.filter(({ name }) => (
      name !== '0020_capability_overrides.sql'
    )))

    await insertStaff('stf_authority_backfill')
    await insertStaff('stf_authority_changer')
    await applyD1Migrations(env.DB, [authorityMigration])

    await insertStaff('stf_authority_catalog')
    await insertStaff('stf_authority_override')
    await insertStaff('stf_authority_history')
  })

  it('creates the exact tables, columns, foreign keys, and lookup indexes', async () => {
    expect(await all(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name LIKE 'staff_capability_%'
          OR type='table' AND name='staff_authorities'
       ORDER BY name`,
    )).toEqual([
      { name: 'staff_authorities' },
      { name: 'staff_capability_override_history' },
      { name: 'staff_capability_overrides' },
    ])

    const expectedColumns = {
      staff_authorities: [
        'staff_id', 'revision', 'updated_at',
      ],
      staff_capability_overrides: [
        'staff_id', 'capability', 'decision', 'version', 'changed_by_staff_id',
        'created_at', 'updated_at',
      ],
      staff_capability_override_history: [
        'id', 'staff_id', 'capability', 'role_at_change', 'decision',
        'override_version', 'authority_revision', 'changed_by_staff_id', 'reason',
        'changed_at',
      ],
    }
    for (const [table, columns] of Object.entries(expectedColumns)) {
      expect((await all(`PRAGMA table_info(${table})`)).map(({ name }) => name))
        .toEqual(columns)
    }

    expect(await foreignKeys('staff_authorities')).toEqual([
      'staff_id->staff_users.id:RESTRICT/RESTRICT',
    ])
    expect(await foreignKeys('staff_capability_overrides')).toEqual([
      'changed_by_staff_id->staff_users.id:RESTRICT/RESTRICT',
      'staff_id->staff_users.id:RESTRICT/RESTRICT',
    ])
    expect(await foreignKeys('staff_capability_override_history')).toEqual([
      'changed_by_staff_id->staff_users.id:RESTRICT/RESTRICT',
      'staff_id->staff_users.id:RESTRICT/RESTRICT',
    ])

    const indexes = (await all(
      `SELECT name FROM sqlite_master
       WHERE type='index' AND name LIKE 'staff_capability_%' AND sql IS NOT NULL
       ORDER BY name`,
    )).map(({ name }) => name)
    expect(indexes).toEqual([
      'staff_capability_override_history_changed_by_staff_idx',
      'staff_capability_override_history_staff_capability_version_unique_idx',
      'staff_capability_override_history_staff_revision_idx',
      'staff_capability_overrides_changed_by_staff_idx',
      'staff_capability_overrides_staff_decision_idx',
    ])
    expect(await indexColumns('staff_capability_overrides_staff_decision_idx'))
      .toEqual(['staff_id', 'decision', 'capability'])
    expect(await indexColumns('staff_capability_override_history_staff_revision_idx'))
      .toEqual(['staff_id', 'authority_revision', 'capability', 'override_version'])
    expect(await env.DB.prepare('PRAGMA foreign_key_check').all())
      .toMatchObject({ results: [] })
  })

  it('accepts exactly the Task 8 catalog in both current and history rows', async () => {
    for (const [index, capability] of CAPABILITIES.entries()) {
      await run(
        `INSERT INTO staff_capability_overrides
         (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
         VALUES ('stf_authority_catalog',?,'cleared',1,'stf_authority_changer',?,?)`,
        capability,
        NOW,
        NOW,
      )
      await run(
        `INSERT INTO staff_capability_override_history
         (id,staff_id,capability,role_at_change,decision,override_version,
          authority_revision,changed_by_staff_id,reason,changed_at)
         VALUES (?,'stf_authority_catalog',?,'owner','cleared',1,2,
                 'stf_authority_changer','owner_update',?)`,
        `cph_catalog_${index}`,
        capability,
        NOW,
      )
    }

    expect((await all(
      `SELECT capability FROM staff_capability_overrides
       WHERE staff_id='stf_authority_catalog' ORDER BY capability`,
    )).map(({ capability }) => capability)).toEqual(CAPABILITIES)
    expect((await all(
      `SELECT capability FROM staff_capability_override_history
       WHERE staff_id='stf_authority_catalog' ORDER BY capability`,
    )).map(({ capability }) => capability)).toEqual(CAPABILITIES)

    await expect(run(
      `INSERT INTO staff_capability_overrides
       (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
       VALUES ('stf_authority_override','finance.*','deny',1,
               'stf_authority_changer',?,?)`,
      NOW,
      NOW,
    )).rejects.toThrow(/CHECK constraint failed/)
    await expect(run(
      `INSERT INTO staff_capability_override_history
       (id,staff_id,capability,role_at_change,decision,override_version,
        authority_revision,changed_by_staff_id,reason,changed_at)
       VALUES ('cph_unknown','stf_authority_history','finance.*','owner','deny',1,2,
               'stf_authority_changer','owner_update',?)`,
      NOW,
    )).rejects.toThrow(/CHECK constraint failed/)
  })

  it('backfills revision one and creates it automatically for every later staff row', async () => {
    expect(await all(
      `SELECT staff_id,revision,updated_at FROM staff_authorities
       WHERE staff_id IN ('stf_authority_backfill','stf_authority_changer')
       ORDER BY staff_id`,
    )).toEqual([
      { revision: 1, staff_id: 'stf_authority_backfill', updated_at: NOW },
      { revision: 1, staff_id: 'stf_authority_changer', updated_at: NOW },
    ])

    await insertStaff('stf_authority_future', LATER)
    expect(await all(
      `SELECT staff_id,revision,updated_at FROM staff_authorities
       WHERE staff_id='stf_authority_future'`,
    )).toEqual([
      { revision: 1, staff_id: 'stf_authority_future', updated_at: LATER },
    ])
  })

  it('allows only contiguous authority revisions and preserves authority identity', async () => {
    await run(
      `UPDATE staff_authorities SET revision=2,updated_at=?
       WHERE staff_id='stf_authority_backfill'`,
      LATER,
    )
    await expect(run(
      `UPDATE staff_authorities SET revision=4,updated_at=?
       WHERE staff_id='stf_authority_backfill'`,
      LATEST,
    )).rejects.toThrow(/invalid_authority_revision_increment/)
    await expect(run(
      `UPDATE staff_authorities
       SET staff_id='stf_authority_changer',revision=3,updated_at=?
       WHERE staff_id='stf_authority_backfill'`,
      LATEST,
    )).rejects.toThrow(/immutable_staff_authority_identity/)
    await expect(run(
      `DELETE FROM staff_authorities WHERE staff_id='stf_authority_backfill'`,
    )).rejects.toThrow(/no_routine_delete/)
    expect(await env.DB.prepare(
      `SELECT staff_id,revision,updated_at FROM staff_authorities
       WHERE staff_id='stf_authority_backfill'`,
    ).first()).toEqual({
      revision: 2,
      staff_id: 'stf_authority_backfill',
      updated_at: LATER,
    })
  })

  it('starts current overrides at one and allows only contiguous version updates', async () => {
    await expect(run(
      `INSERT INTO staff_capability_overrides
       (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
       VALUES ('stf_authority_override','finance.import','allow',2,
               'stf_authority_changer',?,?)`,
      NOW,
      NOW,
    )).rejects.toThrow(/invalid_override_initial_version/)
    await run(
      `INSERT INTO staff_capability_overrides
       (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
       VALUES ('stf_authority_override','finance.import','allow',1,
               'stf_authority_changer',?,?)`,
      NOW,
      NOW,
    )
    await expect(run(
      `UPDATE staff_capability_overrides
       SET decision='deny',version=3,updated_at=?
       WHERE staff_id='stf_authority_override' AND capability='finance.import'`,
      LATER,
    )).rejects.toThrow(/invalid_override_version_increment/)
    await run(
      `UPDATE staff_capability_overrides
       SET decision='deny',version=2,updated_at=?
       WHERE staff_id='stf_authority_override' AND capability='finance.import'`,
      LATER,
    )
    await expect(run(
      `UPDATE staff_capability_overrides
       SET capability='finance.centre.read',version=3,updated_at=?
       WHERE staff_id='stf_authority_override' AND capability='finance.import'`,
      LATEST,
    )).rejects.toThrow(/immutable_capability_override_identity/)
    await expect(run(
      `UPDATE staff_capability_overrides
       SET created_at=?,version=3,updated_at=?
       WHERE staff_id='stf_authority_override' AND capability='finance.import'`,
      LATER,
      LATEST,
    )).rejects.toThrow(/immutable_capability_override_identity/)
    await expect(run(
      `DELETE FROM staff_capability_overrides
       WHERE staff_id='stf_authority_override' AND capability='finance.import'`,
    )).rejects.toThrow(/no_routine_delete/)
    expect(await env.DB.prepare(
      `SELECT decision,version,changed_by_staff_id,created_at,updated_at
       FROM staff_capability_overrides
       WHERE staff_id='stf_authority_override' AND capability='finance.import'`,
    ).first()).toEqual({
      changed_by_staff_id: 'stf_authority_changer',
      created_at: NOW,
      decision: 'deny',
      updated_at: LATER,
      version: 2,
    })
  })

  it('keeps history append-only with contiguous override and authority revisions', async () => {
    await run(
      `INSERT INTO staff_capability_overrides
       (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
       VALUES ('stf_authority_history','staff.manage','deny',1,
               'stf_authority_changer',?,?)`,
      NOW,
      NOW,
    )
    await run(
      `INSERT INTO staff_capability_override_history
       (id,staff_id,capability,role_at_change,decision,override_version,
        authority_revision,changed_by_staff_id,reason,changed_at)
       VALUES ('cph_history_one','stf_authority_history','staff.manage','owner','deny',1,2,
               'stf_authority_changer','owner_update',?)`,
      NOW,
    )
    await expect(run(
      `INSERT INTO staff_capability_override_history
       (id,staff_id,capability,role_at_change,decision,override_version,
        authority_revision,changed_by_staff_id,reason,changed_at)
       VALUES ('cph_history_skip','stf_authority_history','staff.manage','owner','allow',3,2,
               'stf_authority_changer','owner_update',?)`,
      LATER,
    )).rejects.toThrow(/invalid_override_history_version/)

    await run(
      `UPDATE staff_authorities SET revision=2,updated_at=?
       WHERE staff_id='stf_authority_history'`,
      LATER,
    )
    await run(
      `UPDATE staff_capability_overrides
       SET decision='cleared',version=2,updated_at=?
       WHERE staff_id='stf_authority_history' AND capability='staff.manage'`,
      LATER,
    )
    await expect(run(
      `INSERT INTO staff_capability_override_history
       (id,staff_id,capability,role_at_change,decision,override_version,
        authority_revision,changed_by_staff_id,reason,changed_at)
       VALUES ('cph_history_wrong_revision','stf_authority_history','staff.manage',
               'owner','cleared',2,4,'stf_authority_changer','role_change',?)`,
      LATER,
    )).rejects.toThrow(/invalid_history_authority_revision/)
    await run(
      `INSERT INTO staff_capability_override_history
       (id,staff_id,capability,role_at_change,decision,override_version,
        authority_revision,changed_by_staff_id,reason,changed_at)
       VALUES ('cph_history_two','stf_authority_history','staff.manage','owner','cleared',2,3,
               'stf_authority_changer','role_change',?)`,
      LATER,
    )

    await expect(run(
      `UPDATE staff_capability_override_history SET reason='status_change'
       WHERE id='cph_history_one'`,
    )).rejects.toThrow(/append_only/)
    await expect(run(
      `DELETE FROM staff_capability_override_history WHERE id='cph_history_one'`,
    )).rejects.toThrow(/no_routine_delete/)
    expect(await all(
      `SELECT id,decision,override_version,authority_revision,reason
       FROM staff_capability_override_history
       WHERE staff_id='stf_authority_history' ORDER BY override_version`,
    )).toEqual([
      {
        authority_revision: 2,
        decision: 'deny',
        id: 'cph_history_one',
        override_version: 1,
        reason: 'owner_update',
      },
      {
        authority_revision: 3,
        decision: 'cleared',
        id: 'cph_history_two',
        override_version: 2,
        reason: 'role_change',
      },
    ])
  })

  it('rejects invalid decisions, roles, reasons, identities, and foreign keys', async () => {
    await expect(run(
      `INSERT INTO staff_capability_overrides
       (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
       VALUES ('stf_authority_override','client.manage','remove',1,
               'stf_authority_changer',?,?)`,
      NOW,
      NOW,
    )).rejects.toThrow(/CHECK constraint failed/)
    await expect(run(
      `INSERT INTO staff_capability_override_history
       (id,staff_id,capability,role_at_change,decision,override_version,
        authority_revision,changed_by_staff_id,reason,changed_at)
       VALUES ('history_bad_id','stf_authority_history','client.manage','administrator',
               'deny',1,3,'stf_missing','manual',?)`,
      NOW,
    )).rejects.toThrow(/CHECK constraint failed/)
    await expect(run(
      `INSERT INTO staff_capability_overrides
       (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
       VALUES ('stf_missing','client.manage','deny',1,
               'stf_authority_changer',?,?)`,
      NOW,
      NOW,
    )).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })
})
