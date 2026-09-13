import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { selectCoreMigrationStage } from '../../scripts/core-migration-stages.js'

const CREATED_AT = '2027-01-15T09:00:00.000Z'
const BACKDATED_AT = '2026-01-15T09:00:00.000Z'

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_STAGE_A_MIGRATIONS)
  const stageF = selectCoreMigrationStage(env.TEST_STAGE_F_MIGRATIONS, 'stage-f')
  await applyD1Migrations(env.DB, [
    stageF.find((migration) => migration.name === '0026_assignment_starts_at.sql'),
  ])
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_assignment_start', 'lookup_assignment_start', '{}', '{}', 'coordinator',
      'active', 'access-assignment-start', 'sp_assignment_start', 1,
      CREATED_AT, null, CREATED_AT, CREATED_AT,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_assignment_start', 'stf_assignment_start', 18_000, 'active', 1,
      null, CREATED_AT, CREATED_AT,
    ),
    env.DB.prepare(`INSERT INTO clients
      (id,identity_envelope,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,1,NULL,?,?)`).bind(
      'cl_assignment_start', '{}', 'active', CREATED_AT, CREATED_AT,
    ),
    env.DB.prepare(`INSERT INTO client_assignments
      (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
       version,created_at,updated_at)
      VALUES (?,?,?,?,NULL,?,1,?,?)`).bind(
      'asg_assignment_start', 'cl_assignment_start', 'sp_assignment_start',
      CREATED_AT, 'stf_assignment_start', CREATED_AT, CREATED_AT,
    ),
  ])
})

describe('assignment starts_at migration', () => {
  it('allows one versioned open-assignment change and keeps identity and interval guarded', async () => {
    await expect(env.DB.prepare(`UPDATE client_assignments
      SET starts_at=?,version=2,updated_at=? WHERE id=?`).bind(
      BACKDATED_AT, '2027-01-15T09:00:01.000Z', 'asg_assignment_start',
    ).run()).resolves.toBeTruthy()
    expect(await env.DB.prepare(
      'SELECT starts_at,ends_at,version,created_at,updated_at FROM client_assignments WHERE id=?'
    ).bind('asg_assignment_start').first()).toEqual({
      starts_at: BACKDATED_AT, ends_at: null, version: 2,
      created_at: CREATED_AT, updated_at: '2027-01-15T09:00:01.000Z',
    })

    await expect(env.DB.prepare(`UPDATE client_assignments
      SET starts_at=?,version=2,updated_at=? WHERE id=?`).bind(
      '2025-01-15T09:00:00.000Z', '2027-01-15T09:00:02.000Z',
      'asg_assignment_start',
    ).run()).rejects.toThrow()
    await expect(env.DB.prepare(`UPDATE client_assignments
      SET starts_at=?,version=3,updated_at=updated_at WHERE id=?`).bind(
      '2025-01-15T09:00:00.000Z', 'asg_assignment_start',
    ).run()).rejects.toThrow()
    await expect(env.DB.prepare(`UPDATE client_assignments
      SET starts_at=?,ends_at=?,version=3,updated_at=? WHERE id=?`).bind(
      '2025-01-15T09:00:00.000Z', '2027-01-15T10:00:00.000Z',
      '2027-01-15T09:00:03.000Z', 'asg_assignment_start',
    ).run()).rejects.toThrow()

    await expect(env.DB.prepare(`UPDATE client_assignments
      SET ends_at=?,version=3,updated_at=? WHERE id=?`).bind(
      '2025-01-15T09:00:00.000Z', '2027-01-15T09:00:03.000Z',
      'asg_assignment_start',
    ).run()).rejects.toThrow()
    await expect(env.DB.prepare(`UPDATE client_assignments
      SET ends_at=?,version=3,updated_at=? WHERE id=?`).bind(
      '2027-01-15T10:00:00.000Z', '2027-01-15T09:00:03.000Z',
      'asg_assignment_start',
    ).run()).resolves.toBeTruthy()
    await expect(env.DB.prepare(`UPDATE client_assignments
      SET starts_at=?,version=4,updated_at=? WHERE id=?`).bind(
      '2025-01-15T09:00:00.000Z', '2027-01-15T09:00:04.000Z',
      'asg_assignment_start',
    ).run()).rejects.toThrow()
  })
})
