import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import {
  linkSpecialistAccount,
  validateSpecialistAccountLinkBody,
} from '../../worker/core/specialist-account-links.js'
import {
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  createD1QueryBudget,
  usageForD1QueryBudgetViews,
} from '../../worker/db/query-budget.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2026-08-27T14:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const CORRELATION_ID = '71717171-7171-4717-8717-717171717171'
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
let cryptoContext
let serial = 0

const next = (prefix) => `${prefix}_${++serial}`
const lookup = () => serial.toString(36).padStart(43, 'x')
const ids = (prefix) => {
  let value = 0
  return () => `${prefix}_${++value}`
}
const run = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).run()
const count = async (table) => (
  await env.DB.prepare(`SELECT count(*) AS count FROM ${table}`).first()
).count

const envelope = async (recordId, field, plaintext) => JSON.stringify(
  await encryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
    expectedScope: SCOPE, recordId, field, plaintext,
  }),
)

const insertVersion = async ({ id, entityType, entityId, version, snapshot, actorId }) => {
  await run(
    `INSERT INTO record_versions
     (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
      changed_at,correlation_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    entityType,
    entityId,
    version,
    await envelope(entityId, 'record_version', JSON.stringify(snapshot)),
    actorId,
    NOW,
    CORRELATION_ID,
  )
}

const seedStaff = async ({
  id = next('stf_link'),
  role = 'owner',
  status = 'active',
  specialistId = null,
  version = 1,
} = {}) => {
  const row = {
    id,
    email_lookup: lookup(),
    email_envelope: await envelope(id, 'email', `${id}@example.test`),
    display_name_envelope: await envelope(id, 'display_name', `Osoba ${id}`),
    role,
    status,
    access_subject: status === 'active' ? `subject_${id}` : null,
    specialist_id: specialistId,
    version,
    activated_at: status === 'active' ? NOW : null,
    disabled_at: status === 'disabled' ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
  }
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(...Object.values(row)).run()
  await insertVersion({
    id: `ver_seed_staff_${id.slice(4)}`,
    entityType: 'staff_user',
    entityId: id,
    version,
    snapshot: row,
    actorId: id,
  })
  return Object.freeze(row)
}

const specialistSnapshot = (row, displayName, professionalTitle) => ({
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  displayName,
  id: row.id,
  professionalTitle,
  schema: 'specialist.v3',
  staffUserId: row.staff_user_id,
  standardRateGrosze: row.standard_rate_grosze,
  status: row.status,
  updatedAt: row.updated_at,
  version: row.version,
})

const seedProfile = async ({
  id = next('sp_link'),
  staffId = null,
  status = 'active',
  version = 1,
  professionalTitle = 'Specjalistka',
  titleField = 'professional_title',
} = {}) => {
  const displayName = `Profil ${id}`
  const row = {
    id,
    staff_user_id: staffId,
    display_name_envelope: await envelope(id, 'display_name', displayName),
    standard_rate_grosze: 18000,
    status,
    version,
    archived_at: status === 'archived' ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
    professional_title_envelope: professionalTitle === null
      ? null
      : await envelope(id, titleField, professionalTitle),
  }
  await env.DB.prepare(
    `INSERT INTO specialists
     (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
      archived_at,created_at,updated_at,professional_title_envelope)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(...Object.values(row)).run()
  await insertVersion({
    id: `ver_seed_specialist_${id.slice(3)}`,
    entityType: 'specialist',
    entityId: id,
    version,
    snapshot: specialistSnapshot(row, displayName, professionalTitle ?? 'Specjalistka'),
    actorId: staffId,
  })
  return Object.freeze({ ...row, displayName, professionalTitle })
}

const command = ({ actor, staff, profile, key = next('link-key'), db = env.DB } = {}) => ({
  db,
  recoveryDb: env.DB,
  actor: authorityActor({
    id: actor.id,
    role: actor.role,
    specialistId: actor.specialist_id,
    version: actor.version,
  }),
  keyring: cryptoContext.keyring,
  nowMs: NOW_MS,
  correlationId: CORRELATION_ID,
  idFactory: ids(key.replaceAll(/[^A-Za-z0-9_-]/g, '_')),
  specialistId: profile.id,
  body: {
    staffId: staff.id,
    expectedSpecialistVersion: profile.version,
    expectedStaffVersion: staff.version,
  },
  idempotencyKey: key.padEnd(8, 'x'),
})

const seedOwnerAndProfile = async (suffix = next('fixture')) => {
  const staff = await seedStaff({ id: `stf_${suffix}`, role: 'owner' })
  const profile = await seedProfile({ id: `sp_${suffix}` })
  return Object.freeze({ actor: staff, staff, profile })
}

const facts = async ({ staffId, specialistId }) => Object.freeze({
  staff: await env.DB.prepare(
    `SELECT specialist_id,role,status,access_subject,version,activated_at,disabled_at,
            created_at,updated_at
     FROM staff_users WHERE id=?`,
  ).bind(staffId).first(),
  profile: await env.DB.prepare(
    `SELECT staff_user_id,display_name_envelope,professional_title_envelope,
            standard_rate_grosze,status,version,archived_at,created_at,updated_at
     FROM specialists WHERE id=?`,
  ).bind(specialistId).first(),
  links: await count('specialist_account_links'),
  versions: await count('record_versions'),
  audits: await count('audit_events'),
  idempotency: await count('idempotency_records'),
})

describe('specialist account link command', () => {
  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await applyFinanceStageC()
    await applySpecialistProfilesStageD()
    await applyWorkbookRegistryStageE()
    const keyring = await createKeyring(env, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
    const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
      id: 'key_dual_role_directory', createdAt: NOW,
    })
    cryptoContext = Object.freeze({ keyring, dataKey })
  })

  it('strictly validates both optimistic versions and the target staff ID', () => {
    const valid = {
      staffId: 'stf_target_account',
      expectedSpecialistVersion: 3,
      expectedStaffVersion: 7,
    }
    expect(validateSpecialistAccountLinkBody(valid)).toEqual(valid)
    expect(Object.isFrozen(validateSpecialistAccountLinkBody(valid))).toBe(true)
    for (const value of [
      { ...valid, staffId: 'bad' },
      { ...valid, expectedSpecialistVersion: 0 },
      { ...valid, expectedStaffVersion: 1.5 },
      { ...valid, centreId: 'centre_1' },
      { staffId: valid.staffId, expectedStaffVersion: 7 },
    ]) expect(() => validateSpecialistAccountLinkBody(value)).toThrow('VALIDATION_FAILED')
  })

  it('links an owner to a professional profile without changing authorization facts', async () => {
    const fixture = await seedOwnerAndProfile()
    const before = await facts({ staffId: fixture.staff.id, specialistId: fixture.profile.id })
    const input = command({ ...fixture, key: next('link-owner') })
    const result = await linkSpecialistAccount(input)

    expect(result).toEqual({
      status: 201,
      body: { data: { link: {
        id: expect.stringMatching(/^spl_/),
        specialistId: fixture.profile.id,
        staffId: fixture.staff.id,
        lifecycle: 'activated',
        specialistVersion: 2,
        staffVersion: 2,
        createdAt: NOW,
      } } },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.body.data.link)).toBe(true)

    const after = await facts({ staffId: fixture.staff.id, specialistId: fixture.profile.id })
    expect(after.staff).toEqual({
      ...before.staff,
      specialist_id: fixture.profile.id,
      version: 2,
    })
    expect(after.profile).toEqual({
      ...before.profile,
      staff_user_id: fixture.staff.id,
      version: 2,
    })
    expect(after).toMatchObject({
      links: before.links + 1,
      versions: before.versions + 2,
      audits: before.audits + 1,
      idempotency: before.idempotency + 1,
    })

    const link = result.body.data.link
    expect(await env.DB.prepare(
      `SELECT specialist_id,staff_user_id,lifecycle,changed_by_staff_id,version,created_at
       FROM specialist_account_links WHERE id=?`,
    ).bind(link.id).first()).toEqual({
      specialist_id: fixture.profile.id,
      staff_user_id: fixture.staff.id,
      lifecycle: 'activated',
      changed_by_staff_id: fixture.actor.id,
      version: 2,
      created_at: NOW,
    })
    expect(await env.DB.prepare(
      `SELECT action,entity_type,entity_id,actor_staff_id,correlation_id,metadata_json
       FROM audit_events WHERE action='specialist.account.linked' AND entity_id=?`,
    ).bind(fixture.profile.id).first()).toEqual({
      action: 'specialist.account.linked',
      entity_type: 'specialist',
      entity_id: fixture.profile.id,
      actor_staff_id: fixture.actor.id,
      correlation_id: CORRELATION_ID,
      metadata_json: '{"specialistVersion":2,"staffVersion":2}',
    })

    const versions = (await env.DB.prepare(
      `SELECT entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
              changed_at,correlation_id
       FROM record_versions
       WHERE (entity_type='staff_user' AND entity_id=? AND version=2)
          OR (entity_type='specialist' AND entity_id=? AND version=2)
       ORDER BY entity_type`,
    ).bind(fixture.staff.id, fixture.profile.id).all()).results
    expect(versions).toHaveLength(2)
    for (const version of versions) {
      expect(version).toMatchObject({
        version: 2,
        changed_by_staff_id: fixture.actor.id,
        changed_at: NOW,
        correlation_id: CORRELATION_ID,
      })
      const snapshot = JSON.parse(await decryptForScope(
        cryptoContext.keyring,
        cryptoContext.dataKey,
        {
          expectedScope: SCOPE,
          recordId: version.entity_id,
          field: 'record_version',
          envelope: JSON.parse(version.snapshot_envelope),
        },
      ))
      if (version.entity_type === 'staff_user') {
        expect(snapshot).toEqual(await env.DB.prepare(
          'SELECT * FROM staff_users WHERE id=?',
        ).bind(fixture.staff.id).first())
      } else {
        expect(snapshot).toEqual(specialistSnapshot({
          ...fixture.profile,
          staff_user_id: fixture.staff.id,
          version: 2,
        }, fixture.profile.displayName, fixture.profile.professionalTitle))
      }
    }
  })

  it('links a coordinator target while the separate owner remains authoritative', async () => {
    const actor = await seedStaff({ id: next('stf_actor'), role: 'owner' })
    const staff = await seedStaff({ id: next('stf_target'), role: 'coordinator' })
    const profile = await seedProfile()
    const input = command({ actor, staff, profile, key: next('link-coordinator') })
    await expect(linkSpecialistAccount(input)).resolves.toMatchObject({
      body: { data: { link: { staffId: staff.id, specialistId: profile.id } } },
    })
    expect(await env.DB.prepare(
      `SELECT role,status,access_subject,specialist_id,version
       FROM staff_users WHERE id=?`,
    ).bind(staff.id).first()).toEqual({
      role: 'coordinator', status: 'active', access_subject: staff.access_subject,
      specialist_id: profile.id, version: 2,
    })
    expect((await env.DB.prepare(
      'SELECT version FROM staff_users WHERE id=?',
    ).bind(actor.id).first()).version).toBe(1)
  })

  it('links a legacy-null title without changing profile presentation or rate', async () => {
    const staff = await seedStaff({ id: next('stf_legacy_title'), role: 'owner' })
    const profile = await seedProfile({
      id: next('sp_legacy_title'), professionalTitle: null,
    })
    const before = await facts({ staffId: staff.id, specialistId: profile.id })
    const result = await linkSpecialistAccount(command({
      actor: staff, staff, profile, key: next('link-legacy-title'),
    }))
    const after = await facts({ staffId: staff.id, specialistId: profile.id })
    expect(after.profile).toEqual({
      ...before.profile,
      staff_user_id: staff.id,
      version: 2,
    })
    const version = await env.DB.prepare(
      `SELECT snapshot_envelope FROM record_versions
       WHERE entity_type='specialist' AND entity_id=? AND version=2`,
    ).bind(profile.id).first()
    const snapshot = JSON.parse(await decryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: SCOPE,
        recordId: profile.id,
        field: 'record_version',
        envelope: JSON.parse(version.snapshot_envelope),
      },
    ))
    expect(snapshot).toMatchObject({
      schema: 'specialist.v3', professionalTitle: 'Specjalistka',
      standardRateGrosze: 18000, staffUserId: staff.id,
      version: result.body.data.link.specialistVersion,
    })
  })

  it.each(['coordinator', 'specialist'])('denies a %s actor before mutation', async (role) => {
    const fixture = await seedOwnerAndProfile()
    const before = await facts({ staffId: fixture.staff.id, specialistId: fixture.profile.id })
    await expect(linkSpecialistAccount({
      ...command({ ...fixture, key: next(`denied-${role}`) }),
      actor: {
        id: `stf_denied_${role}`,
        role,
        specialistId: role === 'specialist' ? `sp_denied_${role}` : null,
        version: 1,
      },
    })).rejects.toThrow('FORBIDDEN')
    expect(await facts({ staffId: fixture.staff.id, specialistId: fixture.profile.id }))
      .toEqual(before)
  })

  it('returns VERSION_CONFLICT for either stale optimistic version', async () => {
    for (const stale of ['staff', 'profile']) {
      const fixture = await seedOwnerAndProfile(next(`stale-${stale}`))
      const input = command({ ...fixture, key: next(`stale-key-${stale}`) })
      if (stale === 'staff') input.body.expectedStaffVersion += 1
      else input.body.expectedSpecialistVersion += 1
      await expect(linkSpecialistAccount(input)).rejects.toThrow('VERSION_CONFLICT')
      expect((await env.DB.prepare(
        'SELECT specialist_id FROM staff_users WHERE id=?',
      ).bind(fixture.staff.id).first()).specialist_id).toBeNull()
      expect((await env.DB.prepare(
        'SELECT staff_user_id FROM specialists WHERE id=?',
      ).bind(fixture.profile.id).first()).staff_user_id).toBeNull()
    }
  })

  it('fails closed for disabled targets and already claimed profiles', async () => {
    const actor = await seedStaff({ id: next('stf_actor'), role: 'owner' })
    const disabled = await seedStaff({
      id: next('stf_disabled'), role: 'coordinator', status: 'disabled',
    })
    const openProfile = await seedProfile()
    await expect(linkSpecialistAccount(command({
      actor, staff: disabled, profile: openProfile, key: next('disabled-link'),
    }))).rejects.toThrow('SPECIALIST_LINK_CONFLICT')

    const claimedProfileId = next('sp_claimed')
    const claimant = await seedStaff({
      id: next('stf_claimant'), role: 'owner', specialistId: claimedProfileId,
    })
    const claimed = await seedProfile({ id: claimedProfileId, staffId: claimant.id })
    const target = await seedStaff({ id: next('stf_target'), role: 'coordinator' })
    await expect(linkSpecialistAccount(command({
      actor, staff: target, profile: claimed, key: next('claimed-link'),
    }))).rejects.toThrow('SPECIALIST_LINK_CONFLICT')
  })

  it('fails closed for absent, pending, already linked, and malformed specialist targets', async () => {
    const actor = await seedStaff({ id: next('stf_structural_actor'), role: 'owner' })
    const openProfile = await seedProfile({ id: next('sp_structural_open') })
    const missingStaff = { id: next('stf_missing'), version: 1 }
    await expect(linkSpecialistAccount(command({
      actor, staff: missingStaff, profile: openProfile, key: next('missing-staff-link'),
    }))).rejects.toThrow('SPECIALIST_LINK_CONFLICT')

    const openStaff = await seedStaff({ id: next('stf_structural_open'), role: 'owner' })
    const missingProfile = { id: next('sp_missing'), version: 1 }
    await expect(linkSpecialistAccount(command({
      actor, staff: openStaff, profile: missingProfile, key: next('missing-profile-link'),
    }))).rejects.toThrow('SPECIALIST_LINK_CONFLICT')

    const pending = await seedStaff({
      id: next('stf_pending_target'), role: 'coordinator', status: 'pending',
    })
    await expect(linkSpecialistAccount(command({
      actor, staff: pending, profile: openProfile, key: next('pending-target-link'),
    }))).rejects.toThrow('SPECIALIST_LINK_CONFLICT')

    const linkedProfileId = next('sp_linked_target')
    const linked = await seedStaff({
      id: next('stf_linked_target'), role: 'owner', specialistId: linkedProfileId,
    })
    await seedProfile({ id: linkedProfileId, staffId: linked.id })
    await expect(linkSpecialistAccount(command({
      actor, staff: linked, profile: openProfile, key: next('linked-target-link'),
    }))).rejects.toThrow('SPECIALIST_LINK_CONFLICT')

    await run('PRAGMA ignore_check_constraints=ON')
    let malformed
    try {
      malformed = await seedStaff({
        id: next('stf_malformed_specialist'), role: 'specialist', specialistId: null,
      })
    } finally {
      await run('PRAGMA ignore_check_constraints=OFF')
    }
    await expect(linkSpecialistAccount(command({
      actor, staff: malformed, profile: openProfile,
      key: next('malformed-specialist-link'),
    }))).rejects.toThrow('SPECIALIST_LINK_CONFLICT')
    expect((await env.DB.prepare(
      'SELECT specialist_id,role,status,version FROM staff_users WHERE id=?',
    ).bind(malformed.id).first())).toEqual({
      specialist_id: null, role: 'specialist', status: 'active', version: 1,
    })
  })

  it.each([
    ['wrong title AAD', 'display_name', 'Specjalistka'],
    ['format character', 'professional_title', 'Specjalistka\u200b'],
  ])('rejects a present encrypted professional title with %s', async (
    _case,
    titleField,
    professionalTitle,
  ) => {
    const staff = await seedStaff({ id: next('stf_title_actor'), role: 'owner' })
    const profile = await seedProfile({
      id: next('sp_title_profile'), professionalTitle, titleField,
    })
    await expect(linkSpecialistAccount(command({
      actor: staff, staff, profile, key: next('invalid-title-link'),
    }))).rejects.toThrow('CRYPTO_FAILURE')
    expect((await env.DB.prepare(
      'SELECT specialist_id FROM staff_users WHERE id=?',
    ).bind(staff.id).first()).specialist_id).toBeNull()
  })

  it('replays before stale self-link gates and rejects a changed body for the same key', async () => {
    const fixture = await seedOwnerAndProfile()
    const input = command({ ...fixture, key: next('replay-link') })
    const first = await linkSpecialistAccount(input)
    await expect(linkSpecialistAccount(input)).resolves.toEqual(first)
    await expect(linkSpecialistAccount({
      ...input,
      body: { ...input.body, expectedSpecialistVersion: 2 },
    })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM specialist_account_links WHERE specialist_id=?',
    ).bind(fixture.profile.id).first()).count).toBe(1)
  })

  it('recovers only the authenticated winner of an idempotency collision', async () => {
    const fixture = await seedOwnerAndProfile(next('winner-race'))
    const key = next('link-winner-race').padEnd(8, 'x')
    const winnerIds = ['winner_link', 'winner_staff_version', 'winner_profile_version', 'winner_audit']
    const winner = {
      ...command({ ...fixture, key }),
      idFactory: () => winnerIds.shift(),
    }
    let raced = false
    const loserDb = {
      prepare: (...args) => env.DB.prepare(...args),
      batch: async () => {
        if (!raced) {
          raced = true
          await linkSpecialistAccount(winner)
        }
        throw new Error('identity_collision: SQLITE_CONSTRAINT')
      },
    }
    const loserIds = ['loser_link', 'loser_staff_version', 'loser_profile_version', 'loser_audit']
    const recovered = await linkSpecialistAccount({
      ...command({ ...fixture, key, db: loserDb }),
      idFactory: () => loserIds.shift(),
    })
    expect(recovered.body.data.link.id).toBe('spl_winner_link')
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM specialist_account_links WHERE specialist_id=?',
    ).bind(fixture.profile.id).first()).count).toBe(1)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM record_versions WHERE id LIKE 'ver_loser_%'",
    ).first()).count).toBe(0)
  })

  it('normalizes an optimistic race and rolls back every partial statement', async () => {
    const fixture = await seedOwnerAndProfile()
    const before = await facts({ staffId: fixture.staff.id, specialistId: fixture.profile.id })
    let raced = false
    const raceDb = {
      prepare: (...args) => env.DB.prepare(...args),
      batch: async (statements) => {
        if (!raced) {
          raced = true
          await run(
            'UPDATE specialists SET version=version+1,updated_at=? WHERE id=?',
            new Date(NOW_MS + 1_000).toISOString(),
            fixture.profile.id,
          )
        }
        return env.DB.batch(statements)
      },
    }
    await expect(linkSpecialistAccount(command({
      ...fixture, key: next('race-link'), db: raceDb,
    }))).rejects.toThrow('VERSION_CONFLICT')
    const after = await facts({ staffId: fixture.staff.id, specialistId: fixture.profile.id })
    expect(after.staff).toEqual(before.staff)
    expect(after.profile).toEqual({
      ...before.profile,
      version: 2,
      updated_at: new Date(NOW_MS + 1_000).toISOString(),
    })
    expect(after).toMatchObject({
      links: before.links,
      versions: before.versions,
      audits: before.audits,
      idempotency: before.idempotency,
    })
  })

  it('rolls back pointers, histories and audit when append-only link identity collides', async () => {
    const fixture = await seedOwnerAndProfile()
    const input = command({ ...fixture, key: 'collision-link-key' })
    const collidingId = 'spl_collision-link-key_1'
    await run(
      `INSERT INTO specialist_account_links
       (id,specialist_id,staff_user_id,lifecycle,changed_by_staff_id,version,created_at)
       VALUES (?,?,?,'released',?,1,?)`,
      collidingId,
      fixture.profile.id,
      fixture.staff.id,
      fixture.actor.id,
      NOW,
    )
    const before = await facts({ staffId: fixture.staff.id, specialistId: fixture.profile.id })
    await expect(linkSpecialistAccount(input)).rejects.toThrow('SPECIALIST_LINK_CONFLICT')
    expect(await facts({ staffId: fixture.staff.id, specialistId: fixture.profile.id }))
      .toEqual(before)
  })

  it('rolls back authorization, pointers, histories, audit, and replay at every batch position', async () => {
    const observed = await seedOwnerAndProfile(next('observe-batch'))
    let batchLength = 0
    const observeDb = {
      prepare: (...args) => env.DB.prepare(...args),
      batch: async (statements) => {
        batchLength = statements.length
        throw new Error('INJECTED_STATEMENT_FAILURE')
      },
    }
    await expect(linkSpecialistAccount(command({
      ...observed, key: next('observe-batch-key'), db: observeDb,
    }))).rejects.toThrow('INJECTED_STATEMENT_FAILURE')
    expect(batchLength).toBe(8)

    for (let failedAt = 0; failedAt < batchLength; failedAt += 1) {
      const fixture = await seedOwnerAndProfile(next(`rollback-${failedAt}`))
      const before = await facts({ staffId: fixture.staff.id, specialistId: fixture.profile.id })
      const failingDb = {
        prepare: (...args) => env.DB.prepare(...args),
        batch: (statements) => env.DB.batch(statements.map((statement, index) => (
          index === failedAt
            ? env.DB.prepare('INSERT INTO missing_specialist_link_failure VALUES (1)')
            : statement
        ))),
      }
      await expect(linkSpecialistAccount(command({
        ...fixture, key: next(`rollback-key-${failedAt}`), db: failingDb,
      }))).rejects.toThrow()
      expect(await facts({ staffId: fixture.staff.id, specialistId: fixture.profile.id }))
        .toEqual(before)
    }
  })

  it('stays inside the shared 50/8 D1 budget', async () => {
    const fixture = await seedOwnerAndProfile(next('bounded-link'))
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    await linkSpecialistAccount(command({
      ...fixture, key: next('bounded-link-key'), db: budget.work,
    }))
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 13, remaining: 37, workRemaining: 29,
      totalLimit: 50, recoveryReserve: 8,
    })
  })
})
