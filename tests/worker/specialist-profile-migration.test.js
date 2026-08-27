import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const now = '2026-08-27T10:00:00.000Z'
const later = '2026-08-27T10:05:00.000Z'
const all = async (sql, ...bindings) => (
  await env.DB.prepare(sql).bind(...bindings).all()
).results
const run = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).run()

describe('unclaimed specialist profile migration', () => {
  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await applyFinanceStageC()
    await run(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,
        specialist_id,version,created_at,updated_at)
       VALUES ('stf_existing_profile',?,'{}','{"encrypted":"display"}',
               'specialist','pending','sp_existing_profile',1,?,?)`,
      'e'.repeat(43), now, now,
    )
    await run(
      `INSERT INTO specialists
       (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
       VALUES ('sp_existing_profile','stf_existing_profile',19000,'pending',1,NULL,?,?)`,
      now, now,
    )
    await run(
      `INSERT INTO record_versions
       (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
        changed_at,correlation_id)
       VALUES ('ver_existing_profile','specialist','sp_existing_profile',1,'{}',NULL,?,
               'migration_fixture')`,
      now,
    )
    await applySpecialistProfilesStageD()
  })

  it('retains linked profiles and copies their encrypted display name', async () => {
    expect(await all(
      `SELECT id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version
       FROM specialists WHERE id='sp_existing_profile'`,
    )).toEqual([{
      id: 'sp_existing_profile',
      staff_user_id: 'stf_existing_profile',
      display_name_envelope: '{"encrypted":"display"}',
      standard_rate_grosze: 19000,
      status: 'pending',
      version: 1,
    }])
  })

  it('accepts an active business profile with no e-mail or staff account', async () => {
    await expect(run(
      `INSERT INTO specialists
       (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
        archived_at,created_at,updated_at)
       VALUES ('sp_unclaimed',NULL,'{"encrypted":"name"}',18000,'active',1,NULL,?,?)`,
      now, now,
    )).resolves.toBeDefined()
    expect(await all(
      `SELECT staff_user_id,status FROM specialists WHERE id='sp_unclaimed'`,
    )).toEqual([{ staff_user_id: null, status: 'active' }])
  })

  it('requires a nonempty encrypted display-name envelope', async () => {
    await expect(run(
      `INSERT INTO specialists
       (id,staff_user_id,display_name_envelope,status,created_at,updated_at)
       VALUES ('sp_empty_name',NULL,'','active',?,?)`,
      now, now,
    )).rejects.toThrow()
  })

  it('allows only versioned current-account link changes', async () => {
    await expect(run(
      `UPDATE specialists SET staff_user_id='stf_existing_profile',updated_at=?
       WHERE id='sp_unclaimed'`,
      later,
    )).rejects.toThrow()
    await expect(run(
      `UPDATE specialists SET staff_user_id='stf_existing_profile',version=version+1,updated_at=?
       WHERE id='sp_unclaimed'`,
      later,
    )).rejects.toThrow()
  })

  it('keeps specialist/account lifecycle history append-only', async () => {
    await run(
      `INSERT INTO specialist_account_links
       (id,specialist_id,staff_user_id,lifecycle,changed_by_staff_id,version,created_at)
       VALUES ('spl_one','sp_existing_profile','stf_existing_profile','reserved',
               'stf_existing_profile',1,?)`,
      now,
    )
    await expect(run(
      `UPDATE specialist_account_links SET lifecycle='activated' WHERE id='spl_one'`,
    )).rejects.toThrow()
    await expect(run(
      `DELETE FROM specialist_account_links WHERE id='spl_one'`,
    )).rejects.toThrow()
  })
})
