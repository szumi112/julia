import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import {
  createSpecialistProfile,
  updateSpecialistProfile,
  validateSpecialistProfileBody,
} from '../../worker/core/specialist-profiles.js'
import {
  deactivateStaff,
  inviteSpecialistProfile,
  inviteStaff,
} from '../../worker/identity/invitations.js'
import { resolveActor } from '../../worker/identity/staff.js'
import { readWorkspace } from '../../worker/core/workspace.js'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
import {
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { ensureStagingSpecialistProfiles } from '../../worker/operations/staging-specialist-seed.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = Date.parse('2026-08-27T12:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const CORRELATION_ID = '77777777-7777-4777-8777-777777777777'
const actor = Object.freeze({
  id: 'stf_profile_owner', role: 'owner', specialistId: null, version: 1,
})
let cryptoContext
let targetedInvitation

const encrypted = async (recordId, field, plaintext) => JSON.stringify(
  await encryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
    expectedScope: SCOPE, recordId, field, plaintext,
  }),
)

describe('specialist profile creation', () => {
  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await applyFinanceStageC()
    await applySpecialistProfilesStageD()
    const keyring = await createKeyring(env, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
    const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
      id: 'key_profile_directory', createdAt: NOW,
    })
    cryptoContext = { keyring, dataKey, scope: SCOPE }
    await env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
        specialist_id,version,activated_at,disabled_at,created_at,updated_at)
       VALUES (?,?,?,?,?,'active',?,NULL,1,?,NULL,?,?)`,
    ).bind(
      actor.id, 'p'.repeat(43), await encrypted(actor.id, 'email', 'owner@example.test'),
      await encrypted(actor.id, 'display_name', 'Właścicielka fikcyjna'), actor.role,
      'subject_profile_owner', NOW, NOW, NOW,
    ).run()
  })

  it('strictly validates the name and standard rate', () => {
    expect(validateSpecialistProfileBody({
      displayName: 'Anna Janowska', standardRateGrosze: 18000,
    })).toEqual({ displayName: 'Anna Janowska', standardRateGrosze: 18000 })
    for (const value of [
      { displayName: '', standardRateGrosze: 18000 },
      { displayName: ' Anna Janowska', standardRateGrosze: 18000 },
      { displayName: 'Anna Janowska', standardRateGrosze: 0 },
      { displayName: 'Anna Janowska', standardRateGrosze: 18000, email: 'x@example.test' },
    ]) expect(() => validateSpecialistProfileBody(value)).toThrow('VALIDATION_FAILED')
  })

  it('creates one encrypted unclaimed profile without an account or delivery work', async () => {
    const generated = ['profile_one', 'profile_version_one', 'profile_audit_one']
    const before = {
      staff: (await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first()).count,
      invitations: (await env.DB.prepare('SELECT count(*) AS count FROM staff_invitations').first()).count,
      outbox: (await env.DB.prepare('SELECT count(*) AS count FROM outbox_jobs').first()).count,
    }
    const result = await createSpecialistProfile({
      db: env.DB, recoveryDb: env.DB, actor, keyring: cryptoContext.keyring,
      nowMs: NOW_MS, correlationId: CORRELATION_ID, idFactory: () => generated.shift(),
      body: { displayName: 'Anna Janowska', standardRateGrosze: 18000 },
      idempotencyKey: 'profile-create-one',
    })

    expect(result).toEqual({ status: 201, body: { data: { specialist: {
      id: 'sp_profile_one', displayName: 'Anna Janowska', standardRateGrosze: 18000,
      status: 'active', version: 1, accessStatus: 'unclaimed',
      createdAt: NOW, updatedAt: NOW,
    } } } })
    const profile = await env.DB.prepare(
      'SELECT * FROM specialists WHERE id=?',
    ).bind('sp_profile_one').first()
    expect(profile.staff_user_id).toBeNull()
    expect(profile.display_name_envelope).not.toContain('Anna Janowska')
    expect(await decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
      expectedScope: SCOPE, recordId: profile.id, field: 'display_name',
      envelope: JSON.parse(profile.display_name_envelope),
    })).toBe('Anna Janowska')
    expect({
      staff: (await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first()).count,
      invitations: (await env.DB.prepare('SELECT count(*) AS count FROM staff_invitations').first()).count,
      outbox: (await env.DB.prepare('SELECT count(*) AS count FROM outbox_jobs').first()).count,
    }).toEqual(before)
    expect(await env.DB.prepare(
      `SELECT action,entity_type,entity_id,metadata_json FROM audit_events
       WHERE entity_id='sp_profile_one'`,
    ).first()).toEqual({
      action: 'specialist.profile.created', entity_type: 'specialist',
      entity_id: 'sp_profile_one', metadata_json: '{"specialistVersion":1}',
    })
  })

  it('denies coordinator creation without database residue', async () => {
    const before = (await env.DB.prepare('SELECT count(*) AS count FROM specialists').first()).count
    await expect(createSpecialistProfile({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_profile_coordinator', role: 'coordinator', specialistId: null },
      keyring: cryptoContext.keyring, nowMs: NOW_MS, correlationId: CORRELATION_ID,
      idFactory: () => 'must_not_run',
      body: { displayName: 'Justyna J-J', standardRateGrosze: 18000 },
      idempotencyKey: 'profile-denied-one',
    })).rejects.toThrow('FORBIDDEN')
    expect((await env.DB.prepare('SELECT count(*) AS count FROM specialists').first()).count)
      .toBe(before)
  })

  it('projects the unclaimed profile into the normal workspace directory', async () => {
    const workspace = await readWorkspace({
      db: createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 }).work,
      actor,
      cryptoContext,
      window: {
        from: '2026-08-01', to: '2026-08-31',
        lower: '2026-07-31T22:00:00.000Z', upper: '2026-08-31T22:00:00.000Z',
      },
    })
    expect(workspace.data.specialists).toContainEqual({
      id: 'sp_profile_one', displayName: 'Anna Janowska',
      standardRateGrosze: 18000, status: 'active', version: 1,
      staffVersion: null, accessStatus: 'unclaimed',
    })
  })

  it('reserves the selected stable profile when the owner later enters an e-mail', async () => {
    const result = await inviteSpecialistProfile({
      db: env.DB, cryptoContext, actor, specialistId: 'sp_profile_one',
      input: { email: 'anna.profile@example.test', expectedVersion: 1 },
      idempotencyKey: 'profile-invite-one', correlationId: CORRELATION_ID,
      nowMs: NOW_MS + 1_000, dataMode: 'fictional',
      idFactory: (() => { let value = 0; return () => `targeted_${++value}` })(),
    })
    expect(result.data.staff).toMatchObject({
      role: 'specialist', status: 'pending', specialistId: 'sp_profile_one',
    })
    targetedInvitation = result.data
    const profile = await env.DB.prepare(
      'SELECT staff_user_id,status,version FROM specialists WHERE id=?',
    ).bind('sp_profile_one').first()
    expect(profile).toEqual({
      staff_user_id: result.data.staff.id, status: 'pending', version: 2,
    })
    expect(await env.DB.prepare(
      `SELECT specialist_id,staff_user_id,lifecycle,changed_by_staff_id
       FROM specialist_account_links WHERE specialist_id=?`,
    ).bind('sp_profile_one').first()).toEqual({
      specialist_id: 'sp_profile_one', staff_user_id: result.data.staff.id,
      lifecycle: 'reserved', changed_by_staff_id: actor.id,
    })
  })

  it('edits basic profile data without replacing its stable account link', async () => {
    const before = await env.DB.prepare(
      'SELECT staff_user_id FROM specialists WHERE id=?',
    ).bind('sp_profile_one').first()
    const generated = ['profile_edit_version', 'profile_edit_audit']
    const result = await updateSpecialistProfile({
      db: env.DB, recoveryDb: env.DB, actor, keyring: cryptoContext.keyring,
      nowMs: NOW_MS + 2_000, correlationId: CORRELATION_ID,
      idFactory: () => generated.shift(), specialistId: 'sp_profile_one',
      body: {
        expectedVersion: 2,
        displayName: 'Anna Janowska-Kowalska',
        standardRateGrosze: 19000,
      },
      idempotencyKey: 'profile-edit-one',
    })
    expect(result.body.data.specialist).toMatchObject({
      id: 'sp_profile_one', displayName: 'Anna Janowska-Kowalska',
      standardRateGrosze: 19000, version: 3, accessStatus: 'invited',
    })
    expect(await env.DB.prepare(
      'SELECT staff_user_id FROM specialists WHERE id=?',
    ).bind('sp_profile_one').first()).toEqual(before)
  })

  it('activates the invited account against the same edited profile', async () => {
    await env.DB.prepare(
      `UPDATE staff_invitations
       SET status='pending',access_allowed_at=?,version=version+1,updated_at=?
       WHERE id=? AND status='provisioning'`,
    ).bind(
      new Date(NOW_MS + 2_500).toISOString(),
      new Date(NOW_MS + 2_500).toISOString(),
      targetedInvitation.invitation.id,
    ).run()
    const activated = await resolveActor(env.DB, {
      kind: 'human',
      subject: 'access_anna_profile',
      normalizedEmail: 'anna.profile@example.test',
    }, cryptoContext, {
      nowMs: NOW_MS + 3_000,
      correlationId: '88888888-8888-4888-8888-888888888888',
      idFactory: (() => { let value = 0; return () => `activate_${++value}` })(),
    })
    expect(activated).toMatchObject({
      id: targetedInvitation.staff.id,
      role: 'specialist',
      specialistId: 'sp_profile_one',
    })
    expect(await env.DB.prepare(
      'SELECT staff_user_id,status,version FROM specialists WHERE id=?',
    ).bind('sp_profile_one').first()).toEqual({
      staff_user_id: targetedInvitation.staff.id,
      status: 'active',
      version: 4,
    })
    expect((await env.DB.prepare(
      `SELECT lifecycle FROM specialist_account_links
       WHERE specialist_id=? ORDER BY created_at,lifecycle`,
    ).bind('sp_profile_one').all()).results).toEqual([
      { lifecycle: 'reserved' },
      { lifecycle: 'activated' },
    ])
  })

  it('releases the stable profile when access is disabled so it can be claimed again', async () => {
    await deactivateStaff({
      db: env.DB,
      cryptoContext,
      actor,
      staffId: targetedInvitation.staff.id,
      version: 2,
      idempotencyKey: 'profile-deactivate-one',
      correlationId: '99999999-9999-4999-8999-999999999999',
      nowMs: NOW_MS + 4_000,
      idFactory: (() => { let value = 0; return () => `release_${++value}` })(),
    })
    expect(await env.DB.prepare(
      'SELECT staff_user_id,status,version FROM specialists WHERE id=?',
    ).bind('sp_profile_one').first()).toEqual({
      staff_user_id: null,
      status: 'active',
      version: 5,
    })
    expect((await env.DB.prepare(
      `SELECT lifecycle FROM specialist_account_links
       WHERE specialist_id=? ORDER BY created_at,lifecycle`,
    ).bind('sp_profile_one').all()).results).toEqual([
      { lifecycle: 'reserved' },
      { lifecycle: 'activated' },
      { lifecycle: 'released' },
    ])
  })

  it('records a release when a pending profile invitation is disabled', async () => {
    const created = await createSpecialistProfile({
      db: env.DB, recoveryDb: env.DB, actor, keyring: cryptoContext.keyring,
      nowMs: NOW_MS + 4_500, correlationId: CORRELATION_ID,
      idFactory: (() => {
        const values = ['pending_release', 'pending_release_version', 'pending_release_audit']
        return () => values.shift()
      })(),
      body: { displayName: 'Profil do zwolnienia', standardRateGrosze: 18000 },
      idempotencyKey: 'profile-pending-release-create',
    })
    const specialistId = created.body.data.specialist.id
    const invited = await inviteSpecialistProfile({
      db: env.DB, cryptoContext, actor, specialistId,
      input: { email: 'pending.release@example.test', expectedVersion: 1 },
      idempotencyKey: 'profile-pending-release-invite', correlationId: CORRELATION_ID,
      nowMs: NOW_MS + 5_000, dataMode: 'fictional',
      idFactory: (() => { let value = 0; return () => `pending_release_invite_${++value}` })(),
    })

    await deactivateStaff({
      db: env.DB, cryptoContext, actor,
      staffId: invited.data.staff.id,
      version: invited.data.staff.version,
      idempotencyKey: 'profile-pending-release-disable',
      correlationId: CORRELATION_ID, nowMs: NOW_MS + 5_500,
      idFactory: (() => { let value = 0; return () => `pending_release_disable_${++value}` })(),
    })

    expect((await env.DB.prepare(
      `SELECT lifecycle FROM specialist_account_links
       WHERE specialist_id=? ORDER BY created_at,lifecycle`,
    ).bind(specialistId).all()).results).toEqual([
      { lifecycle: 'reserved' },
      { lifecycle: 'released' },
    ])
  })

  it('keeps the legacy generic specialist invitation compatible after stage D', async () => {
    const result = await inviteStaff({
      db: env.DB, cryptoContext, actor,
      input: {
        displayName: 'Maria Testowa',
        email: 'maria.profile@example.test',
        role: 'specialist',
      },
      idempotencyKey: 'profile-generic-invite-one',
      correlationId: CORRELATION_ID,
      nowMs: NOW_MS + 2_500,
      dataMode: 'fictional',
      idFactory: (() => { let value = 0; return () => `generic_${++value}` })(),
    })
    const profile = await env.DB.prepare(
      'SELECT id,display_name_envelope FROM specialists WHERE id=?',
    ).bind(result.data.staff.specialistId).first()
    expect(await decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
      expectedScope: SCOPE,
      recordId: profile.id,
      field: 'display_name',
      envelope: JSON.parse(profile.display_name_envelope),
    })).toBe('Maria Testowa')
  })

  it('seeds the three resolvable workbook profiles on staging exactly once without creating accounts', async () => {
    const stagingEnv = {
      ...env,
      APP_ENV: 'staging',
      APP_ORIGIN: 'https://staging.bearwithme-panel.app',
    }
    const staffBefore = (await env.DB.prepare(
      'SELECT count(*) AS count FROM staff_users',
    ).first()).count
    await expect(ensureStagingSpecialistProfiles({
      env: stagingEnv,
      scheduledTime: NOW_MS + 3_000,
    })).resolves.toEqual({ createdOrConfirmed: 3 })
    const invited = await inviteSpecialistProfile({
      db: env.DB, cryptoContext, actor,
      specialistId: 'sp_staging_workbook_anna_janowska',
      input: { email: 'anna.seed@example.test', expectedVersion: 1 },
      idempotencyKey: 'profile-seed-invite-one', correlationId: CORRELATION_ID,
      nowMs: NOW_MS + 3_500, dataMode: 'fictional',
      idFactory: (() => { let value = 0; return () => `seed_invite_${++value}` })(),
    })
    await expect(ensureStagingSpecialistProfiles({
      env: stagingEnv,
      scheduledTime: NOW_MS + 4_000,
    })).resolves.toEqual({ createdOrConfirmed: 3 })
    expect((await env.DB.prepare(
      `SELECT id,staff_user_id,status FROM specialists
       WHERE id IN ('sp_staging_workbook_anna_janowska','sp_staging_workbook_julia_wolanin','sp_staging_workbook_justyna_j_j')
       ORDER BY id`,
    ).all()).results).toEqual([
      {
        id: 'sp_staging_workbook_anna_janowska',
        staff_user_id: invited.data.staff.id,
        status: 'pending',
      },
      {
        id: 'sp_staging_workbook_julia_wolanin',
        staff_user_id: null,
        status: 'active',
      },
      {
        id: 'sp_staging_workbook_justyna_j_j',
        staff_user_id: null,
        status: 'active',
      },
    ])
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM staff_users',
    ).first()).count).toBe(staffBefore + 1)
  })
})
