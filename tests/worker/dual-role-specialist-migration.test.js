import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { selectCoreMigrationStage } from '../../scripts/core-migration-stages.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW = '2026-08-27T12:00:00.000Z'
const LATER = '2026-08-27T12:05:00.000Z'
const currentLinkTriggers = Object.freeze([
  'specialists_current_staff_valid_insert',
  'specialists_current_staff_valid_update',
])
const PRE_DUAL_ROLE_MIGRATION_NAMES = Object.freeze([
  '0016_workbook_source_records.sql',
  '0017_historical_workspace.sql',
  '0018_activity_workspace.sql',
])
const run = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).run()
const all = async (sql, ...bindings) => (
  await env.DB.prepare(sql).bind(...bindings).all()
).results
let emailCounter = 0

const specialistTriggerInventory = async () => Object.fromEntries((await all(
  `SELECT name,sql FROM sqlite_master
   WHERE type='trigger' AND tbl_name='specialists' ORDER BY name`,
)).map((row) => [row.name, row.sql]))

const insertStaff = async ({ id, role, status, specialistId }) => {
  const active = status === 'active'
  const disabled = status === 'disabled'
  await run(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?, ?,?,?,?, ?,1,?,?,?,?)`,
    id,
    (++emailCounter).toString(36).padStart(43, 'x'),
    '{"cipher":"email"}',
    '{"cipher":"display"}',
    role,
    status,
    active || disabled ? `subject_${id}` : null,
    specialistId,
    active || disabled ? NOW : null,
    disabled ? LATER : null,
    NOW,
    NOW,
  )
}

const insertSpecialist = ({ id, staffId, status = 'active', title = null }) => run(
  `INSERT INTO specialists
   (id,staff_user_id,display_name_envelope,professional_title_envelope,
    standard_rate_grosze,status,version,archived_at,created_at,updated_at)
   VALUES (?,?,?, ?,18000,?,1,NULL,?,?)`,
  id,
  staffId,
  '{"cipher":"display"}',
  title,
  status,
  NOW,
  NOW,
)

describe('dual-role specialist migration', () => {
  let triggersBefore
  let triggersAfter

  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await applyFinanceStageC()
    await applySpecialistProfilesStageD()
    const stageE = selectCoreMigrationStage(env.TEST_STAGE_E_MIGRATIONS, 'stage-e')
    await applyD1Migrations(env.DB, PRE_DUAL_ROLE_MIGRATION_NAMES.map((name) => (
      stageE.find((migration) => migration.name === name)
    )))
    triggersBefore = await specialistTriggerInventory()
    await applyD1Migrations(env.DB, [stageE.find(({ name }) => (
      name === '0019_dual_role_specialists.sql'
    ))])
    triggersAfter = await specialistTriggerInventory()
  })

  it('adds only the nullable nonempty professional-title ciphertext column', async () => {
    const columns = await all('PRAGMA table_info(specialists)')
    expect(columns.find((column) => column.name === 'professional_title_envelope'))
      .toMatchObject({ type: 'TEXT', notnull: 0 })

    await expect(insertSpecialist({
      id: 'sp_title_null', staffId: null, title: null,
    })).resolves.toBeDefined()
    await expect(insertSpecialist({
      id: 'sp_title_encrypted', staffId: null, title: '{"cipher":"title"}',
    })).resolves.toBeDefined()
    await expect(insertSpecialist({
      id: 'sp_title_empty', staffId: null, title: '',
    })).rejects.toThrow()
  })

  it('preserves the complete specialist trigger inventory and changes only both link guards', () => {
    expect(Object.keys(triggersAfter)).toEqual(Object.keys(triggersBefore))
    for (const [name, sql] of Object.entries(triggersBefore)) {
      if (!currentLinkTriggers.includes(name)) expect(triggersAfter[name]).toBe(sql)
    }
    for (const name of currentLinkTriggers) {
      expect(triggersAfter[name]).not.toBe(triggersBefore[name])
      expect(triggersAfter[name]).toContain("staff.role IN ('owner','coordinator','specialist')")
      expect(triggersAfter[name]).toContain("staff.status IN ('pending','active')")
      expect(triggersAfter[name]).toContain('staff.specialist_id=NEW.id')
    }
  })

  it.each([
    ['owner', 'active'],
    ['owner', 'pending'],
    ['coordinator', 'active'],
    ['coordinator', 'pending'],
    ['specialist', 'active'],
    ['specialist', 'pending'],
  ])('accepts a reciprocal %s/%s professional account', async (role, status) => {
    const suffix = `${role}_${status}`
    const staffId = `stf_dual_${suffix}`
    const specialistId = `sp_dual_${suffix}`
    await insertStaff({ id: staffId, role, status, specialistId })
    await expect(insertSpecialist({
      id: specialistId,
      staffId,
      status,
      title: '{"cipher":"professional-title"}',
    })).resolves.toBeDefined()
  })

  it('rejects disabled, mismatched and duplicate current-account links', async () => {
    await insertStaff({
      id: 'stf_dual_disabled', role: 'owner', status: 'disabled',
      specialistId: 'sp_dual_disabled',
    })
    await expect(insertSpecialist({
      id: 'sp_dual_disabled', staffId: 'stf_dual_disabled',
    })).rejects.toThrow('invalid_specialist_staff_link')

    await insertStaff({
      id: 'stf_dual_mismatch', role: 'coordinator', status: 'active',
      specialistId: 'sp_dual_expected',
    })
    await expect(insertSpecialist({
      id: 'sp_dual_wrong', staffId: 'stf_dual_mismatch',
    })).rejects.toThrow('invalid_specialist_staff_link')

    await insertStaff({
      id: 'stf_dual_duplicate', role: 'owner', status: 'active',
      specialistId: 'sp_dual_first',
    })
    await insertSpecialist({ id: 'sp_dual_first', staffId: 'stf_dual_duplicate' })
    await run(
      `UPDATE staff_users SET specialist_id='sp_dual_second',version=version+1,updated_at=?
       WHERE id='stf_dual_duplicate'`,
      LATER,
    )
    await expect(insertSpecialist({
      id: 'sp_dual_second', staffId: 'stf_dual_duplicate',
    })).rejects.toThrow()
  })

  it('retains the specialist-role requirement for a nonnull profile pointer', async () => {
    await expect(insertStaff({
      id: 'stf_dual_missing_profile', role: 'specialist', status: 'active',
      specialistId: null,
    })).rejects.toThrow()
  })

  it('lets a profile-originated owner unlink preserve every access fact', async () => {
    await insertStaff({
      id: 'stf_dual_unlink_owner', role: 'owner', status: 'active',
      specialistId: 'sp_dual_unlink_owner',
    })
    await insertSpecialist({
      id: 'sp_dual_unlink_owner', staffId: 'stf_dual_unlink_owner',
      title: '{"cipher":"title"}',
    })
    const before = await env.DB.prepare(
      `SELECT role,status,access_subject,activated_at,disabled_at
       FROM staff_users WHERE id='stf_dual_unlink_owner'`,
    ).first()

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE specialists
         SET staff_user_id=NULL,status='archived',archived_at=?,version=version+1,updated_at=?
         WHERE id='sp_dual_unlink_owner'`,
      ).bind(LATER, LATER),
      env.DB.prepare(
        `UPDATE staff_users SET specialist_id=NULL,version=version+1,updated_at=?
         WHERE id='stf_dual_unlink_owner'`,
      ).bind(LATER),
    ])

    expect(await env.DB.prepare(
      `SELECT role,status,access_subject,activated_at,disabled_at
       FROM staff_users WHERE id='stf_dual_unlink_owner'`,
    ).first()).toEqual(before)
  })

  it('rolls back a profile-originated unlink of an active specialist account', async () => {
    await insertStaff({
      id: 'stf_dual_unlink_specialist', role: 'specialist', status: 'active',
      specialistId: 'sp_dual_unlink_specialist',
    })
    await insertSpecialist({
      id: 'sp_dual_unlink_specialist', staffId: 'stf_dual_unlink_specialist',
    })

    await expect(env.DB.batch([
      env.DB.prepare(
        `UPDATE specialists
         SET staff_user_id=NULL,status='archived',archived_at=?,version=version+1,updated_at=?
         WHERE id='sp_dual_unlink_specialist'`,
      ).bind(LATER, LATER),
      env.DB.prepare(
        `UPDATE staff_users SET specialist_id=NULL,version=version+1,updated_at=?
         WHERE id='stf_dual_unlink_specialist'`,
      ).bind(LATER),
    ])).rejects.toThrow()
    expect(await env.DB.prepare(
      `SELECT staff_user_id,status,version FROM specialists
       WHERE id='sp_dual_unlink_specialist'`,
    ).first()).toEqual({
      staff_user_id: 'stf_dual_unlink_specialist', status: 'active', version: 1,
    })
    expect(await env.DB.prepare(
      `SELECT specialist_id,role,status,version FROM staff_users
       WHERE id='stf_dual_unlink_specialist'`,
    ).first()).toEqual({
      specialist_id: 'sp_dual_unlink_specialist', role: 'specialist',
      status: 'active', version: 1,
    })
  })
})
