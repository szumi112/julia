import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import {
  createStagingSpecialistMaterializer,
  STAGING_SPECIALIST_DESIRED_STATE,
} from '../../worker/operations/staging-specialist-materializer.js'
import { ensureStagingSpecialistProfiles } from '../../worker/operations/staging-specialist-seed.js'
import {
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { advanceCoreDirectoryUpgrade } from '../../scripts/upgrade-core-directory-core.js'

const NOW_MS = Date.parse('2026-08-27T16:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
let cryptoContext
let keyring
let activeDb
let serial = 0
let emailCounter = 0

const next = (prefix) => `${prefix}_${++serial}`
const lookup = () => (++emailCounter).toString(36).padStart(43, 'x')
const run = (sql, ...bindings) => activeDb.prepare(sql).bind(...bindings).run()
const envelope = async (recordId, field, plaintext) => JSON.stringify(
  await encryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
    expectedScope: SCOPE, recordId, field, plaintext,
  }),
)

const seedStaff = async ({
  id = next('stf_materializer'),
  displayName,
  role = 'owner',
  status = 'active',
  specialistId = null,
  version = 1,
} = {}) => {
  const row = {
    id,
    email_lookup: lookup(),
    email_envelope: await envelope(id, 'email', `${id}@example.test`),
    display_name_envelope: await envelope(id, 'display_name', displayName),
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
  await activeDb.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(...Object.values(row)).run()
  return Object.freeze(row)
}

const seedProfile = async ({
  id,
  displayName,
  staffId = null,
  status = 'active',
  version = 1,
  rate = 18000,
  professionalTitle = 'Specjalistka',
} = {}) => {
  const row = {
    id,
    staff_user_id: staffId,
    display_name_envelope: await envelope(id, 'display_name', displayName),
    standard_rate_grosze: rate,
    status,
    version,
    archived_at: status === 'archived' ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
    professional_title_envelope: professionalTitle === null
      ? null
      : await envelope(id, 'professional_title', professionalTitle),
  }
  await activeDb.prepare(
    `INSERT INTO specialists
     (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
      archived_at,created_at,updated_at,professional_title_envelope)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(...Object.values(row)).run()
  return Object.freeze(row)
}

const input = (overrides = {}) => ({
  appEnv: 'staging',
  dataMode: 'fictional',
  db: activeDb,
  recoveryDb: activeDb,
  keyring: cryptoContext.keyring,
  nowMs: NOW_MS,
  ...overrides,
})

const seedDesiredProfiles = async ({
  juliaStaff = null,
  juliaProfileId = 'sp_staging_workbook_julia_wolanin',
  annaClaim = null,
  justynaClaim = null,
  juliaTitle = 'Specjalistka',
  juliaRate = 18000,
} = {}) => {
  const byName = new Map(STAGING_SPECIALIST_DESIRED_STATE.map((item) => [
    item.displayName,
    item,
  ]))
  for (const desired of STAGING_SPECIALIST_DESIRED_STATE) {
    const claim = desired.displayName === 'Julia Wolanin'
      ? juliaStaff
      : desired.displayName === 'Anna Janowska' ? annaClaim : justynaClaim
    await seedProfile({
      id: desired.displayName === 'Julia Wolanin' ? juliaProfileId : desired.id,
      displayName: desired.displayName,
      staffId: claim?.id ?? null,
      status: claim?.status ?? 'active',
      professionalTitle: desired.displayName === 'Julia Wolanin'
        ? juliaTitle
        : desired.professionalTitle,
      rate: desired.displayName === 'Julia Wolanin'
        ? juliaRate
        : desired.standardRateGrosze,
    })
  }
  return byName
}

const noCommands = () => createStagingSpecialistMaterializer({
  createProfile: async () => { throw new Error('unexpected create') },
  updateProfile: async () => { throw new Error('unexpected update') },
  linkAccount: async () => { throw new Error('unexpected link') },
})

const directCommands = () => {
  const calls = { create: [], update: [], link: [] }
  const materialize = createStagingSpecialistMaterializer({
    createProfile: async (command) => {
      calls.create.push(command)
      const desiredId = STAGING_SPECIALIST_DESIRED_STATE.find(
        (item) => item.displayName === command.body.displayName,
      ).id
      await seedProfile({
        id: desiredId,
        displayName: command.body.displayName,
        rate: command.body.standardRateGrosze,
        professionalTitle: command.body.professionalTitle,
      })
      return { status: 201, body: { data: { specialist: {
        id: desiredId,
        displayName: command.body.displayName,
        professionalTitle: command.body.professionalTitle,
        standardRateGrosze: command.body.standardRateGrosze,
        status: 'active', version: 1, accessStatus: 'unclaimed',
        createdAt: NOW, updatedAt: NOW,
      } } } }
    },
    updateProfile: async (command) => {
      calls.update.push(command)
      const title = await envelope(
        command.specialistId,
        'professional_title',
        command.body.professionalTitle,
      )
      const display = await envelope(
        command.specialistId,
        'display_name',
        command.body.displayName,
      )
      await run(
        `UPDATE specialists
         SET display_name_envelope=?,professional_title_envelope=?,
             standard_rate_grosze=?,version=version+1,updated_at=?
         WHERE id=? AND version=?`,
        display,
        title,
        command.body.standardRateGrosze,
        NOW,
        command.specialistId,
        command.body.expectedVersion,
      )
      return { status: 200, body: { data: { specialist: {
        id: command.specialistId,
        displayName: command.body.displayName,
        professionalTitle: command.body.professionalTitle,
        standardRateGrosze: command.body.standardRateGrosze,
        status: 'active', version: command.body.expectedVersion + 1,
        staffVersion: null, accessStatus: 'unclaimed',
        createdAt: NOW, updatedAt: NOW,
      } } } }
    },
    linkAccount: async (command) => {
      calls.link.push(command)
      await activeDb.batch([
        activeDb.prepare(
          `UPDATE staff_users SET specialist_id=?,version=version+1,updated_at=?
           WHERE id=? AND version=? AND specialist_id IS NULL`,
        ).bind(
          command.specialistId,
          NOW,
          command.body.staffId,
          command.body.expectedStaffVersion,
        ),
        activeDb.prepare(
          `UPDATE specialists SET staff_user_id=?,version=version+1,updated_at=?
           WHERE id=? AND version=? AND staff_user_id IS NULL`,
        ).bind(
          command.body.staffId,
          NOW,
          command.specialistId,
          command.body.expectedSpecialistVersion,
        ),
      ])
      await run(
        `INSERT INTO specialist_account_links
         (id,specialist_id,staff_user_id,lifecycle,changed_by_staff_id,version,created_at)
         VALUES (?,?,?,'activated',?,?,?)`,
        `spl_materialized_${calls.link.length}`,
        command.specialistId,
        command.body.staffId,
        command.actor.id,
        command.body.expectedSpecialistVersion + 1,
        NOW,
      )
      return { status: 201, body: { data: { link: {
        id: `spl_materialized_${calls.link.length}`,
        specialistId: command.specialistId,
        staffId: command.body.staffId,
        lifecycle: 'activated',
        specialistVersion: command.body.expectedSpecialistVersion + 1,
        staffVersion: command.body.expectedStaffVersion + 1,
        createdAt: NOW,
      } } } }
    },
  })
  return Object.freeze({ calls, materialize })
}

const useScenario = async (bindingName) => {
  const db = env[bindingName]
  if (!db?.prepare || !db?.batch) throw new Error('missing scenario database')
  await applyD1Migrations(db, env.TEST_STAGE_A_MIGRATIONS)
  await advanceCoreDirectoryUpgrade({
    correlationId: '70707070-7070-4707-8707-707070707070',
    cryptoContext: null,
    db,
    idFactory: () => 'aud_materializer_setup',
    nowMs: NOW_MS,
  })
  await applyD1Migrations(db, env.TEST_STAGE_B_MIGRATIONS)
  await applyD1Migrations(db, env.TEST_STAGE_C_MIGRATIONS)
  await applyD1Migrations(db, env.TEST_STAGE_D_MIGRATIONS)
  await applyD1Migrations(db, env.TEST_STAGE_E_MIGRATIONS)
  const dataKey = await getOrCreateDataKey(db, keyring, SCOPE, {
    id: 'key_staging_materializer', createdAt: NOW,
  })
  activeDb = db
  cryptoContext = Object.freeze({ keyring, dataKey })
}

describe('staging specialist desired-state materializer', () => {
  beforeAll(async () => {
    keyring = await createKeyring(env, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
  })

  it.each([
    ['development', 'fictional'],
    ['production', 'fictional'],
    ['staging', 'real'],
  ])('returns without touching dependencies outside staging/fictional (%s/%s)', async (
    appEnv,
    dataMode,
  ) => {
    let touched = false
    const db = Object.freeze({
      get prepare() { touched = true; throw new Error('must not read') },
      get batch() { touched = true; throw new Error('must not write') },
    })
    const materialize = createStagingSpecialistMaterializer({
      createProfile: async () => { touched = true },
      updateProfile: async () => { touched = true },
      linkAccount: async () => { touched = true },
    })
    await expect(materialize({
      appEnv, dataMode, db, recoveryDb: db, keyring: null, nowMs: -1,
    })).resolves.toEqual({ created: 0, updated: 0, linked: 0, confirmed: 0 })
    expect(touched).toBe(false)
  })

  it.each([
    ['development', 'http://127.0.0.1:5174'],
    ['production', 'https://bearwithme-panel.app'],
  ])('keeps the scheduled seed wrapper inert outside staging (%s)', async (
    appEnv,
    appOrigin,
  ) => {
    let touched = false
    const db = Object.freeze({
      get prepare() { touched = true; throw new Error('must not read') },
      get batch() { touched = true; throw new Error('must not write') },
    })
    const runtimeEnv = {
      ...env,
      APP_ENV: appEnv,
      APP_ORIGIN: appOrigin,
      DATA_MODE: 'fictional',
      DB: db,
    }

    await expect(ensureStagingSpecialistProfiles({
      env: runtimeEnv,
      scheduledTime: NOW_MS,
    })).resolves.toEqual({ created: 0, updated: 0, linked: 0, confirmed: 0 })
    expect(touched).toBe(false)
  })

  it.each([
    ['staff', 'MATERIALIZER_STAFF_CAP'],
    ['profile', 'MATERIALIZER_PROFILE_CAP'],
  ])('fails closed when the bounded %s directory exceeds its cap', async (
    kind,
    bindingName,
  ) => {
    await useScenario(bindingName)
    if (kind === 'staff') {
      await run(
        `WITH RECURSIVE counter(value) AS (
           SELECT 1 UNION ALL SELECT value+1 FROM counter WHERE value<129
         )
         INSERT INTO staff_users
         (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
          specialist_id,version,activated_at,disabled_at,created_at,updated_at)
         SELECT printf('stf_materializer_cap_%03d',value),printf('lookup-cap-%03d',value),
                '{}','{}','owner','active',printf('subject-cap-%03d',value),
                NULL,1,?,NULL,?,?
         FROM counter`,
        NOW,
        NOW,
        NOW,
      )
    } else {
      await seedStaff({
        id: 'stf_materializer_profile_cap_owner',
        displayName: 'Julia Wolanin',
        role: 'owner',
      })
      await run(
        `WITH RECURSIVE counter(value) AS (
           SELECT 1 UNION ALL SELECT value+1 FROM counter WHERE value<129
         )
         INSERT INTO specialists
         (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
          archived_at,created_at,updated_at,professional_title_envelope)
         SELECT printf('sp_materializer_cap_%03d',value),NULL,'{}',18000,'active',1,
                NULL,?,?,NULL
         FROM counter`,
        NOW,
        NOW,
      )
    }
    await expect(noCommands()(input())).rejects.toThrow('STAGING_SEED_INVALID')
  })

  it('finds one exact Julia owner and authenticates her existing profile by canonical name', async () => {
    await useScenario('MATERIALIZER_EXACT')
    const juliaId = 'stf_materializer_julia_exact'
    const juliaProfileId = 'sp_materializer_julia_existing_by_name'
    const julia = await seedStaff({
      id: juliaId,
      displayName: 'Julia Wolanin',
      role: 'owner',
      specialistId: juliaProfileId,
    })
    await seedStaff({
      id: 'stf_materializer_other_owner',
      displayName: 'Inna Właścicielka',
      role: 'owner',
    })
    await seedDesiredProfiles({ juliaStaff: julia, juliaProfileId })

    await expect(noCommands()(input())).resolves.toEqual({
      created: 0, updated: 0, linked: 0, confirmed: 4,
    })
    expect(await activeDb.prepare(
      'SELECT role,status,specialist_id FROM staff_users WHERE id=?',
    ).bind(juliaId).first()).toEqual({
      role: 'owner', status: 'active', specialist_id: juliaProfileId,
    })
  })

  it('rejects near and token-reordered owner names without guessing', async () => {
    await useScenario('MATERIALIZER_NEAR')
    const staff = await seedStaff({
      id: 'stf_materializer_near_match',
      displayName: 'Júlia Wolanin',
      role: 'owner',
    })
    await expect(noCommands()(input())).rejects.toThrow('STAGING_SEED_INVALID')

    await run(
      `UPDATE staff_users
       SET display_name_envelope=?,version=version+1,updated_at=?
       WHERE id=? AND version=1`,
      await envelope(staff.id, 'display_name', 'Wolanin Julia'),
      new Date(NOW_MS + 1_000).toISOString(),
      staff.id,
    )
    await expect(noCommands()(input())).rejects.toThrow('STAGING_SEED_INVALID')
  })

  it('rejects multiple exact Julia owner matches without guessing', async () => {
    await useScenario('MATERIALIZER_AMBIGUOUS')
    for (const index of [0, 1]) {
      await seedStaff({
        id: `stf_materializer_match_${index}`,
        displayName: 'Julia Wolanin',
        role: 'owner',
      })
    }
    await expect(noCommands()(input())).rejects.toThrow('STAGING_SEED_INVALID')
  })

  it('rejects a Julia owner already linked to a different reciprocal profile', async () => {
    await useScenario('MATERIALIZER_TOKEN')
    const conflictingProfileId = 'sp_materializer_julia_conflict'
    const julia = await seedStaff({
      id: 'stf_materializer_julia_conflict',
      displayName: 'Julia Wolanin',
      role: 'owner',
      specialistId: conflictingProfileId,
    })
    await seedProfile({
      id: conflictingProfileId,
      displayName: 'Inny profil Julii',
      staffId: julia.id,
    })
    await seedDesiredProfiles()

    await expect(noCommands()(input())).rejects.toThrow('STAGING_SEED_INVALID')
  })

  it('preserves valid pending and active Anna/Justyna reciprocal claims', async () => {
    await useScenario('MATERIALIZER_PRESERVE')
    const julia = await seedStaff({
      id: 'stf_materializer_julia_preserve',
      displayName: 'Julia Wolanin',
      role: 'owner',
      specialistId: 'sp_staging_workbook_julia_wolanin',
    })
    const anna = await seedStaff({
      id: 'stf_materializer_anna_claim',
      displayName: 'Anna Konto',
      role: 'specialist',
      status: 'pending',
      specialistId: 'sp_staging_workbook_anna_janowska',
    })
    const justyna = await seedStaff({
      id: 'stf_materializer_justyna_claim',
      displayName: 'Justyna Konto',
      role: 'coordinator',
      status: 'active',
      specialistId: 'sp_staging_workbook_justyna_j_j',
    })
    await seedDesiredProfiles({
      juliaStaff: julia,
      annaClaim: anna,
      justynaClaim: justyna,
    })
    const before = (await activeDb.prepare(
      `SELECT id,role,status,specialist_id,version FROM staff_users
       WHERE id IN (?,?) ORDER BY id`,
    ).bind(anna.id, justyna.id).all()).results

    await expect(noCommands()(input())).resolves.toEqual({
      created: 0, updated: 0, linked: 0, confirmed: 4,
    })
    expect((await activeDb.prepare(
      `SELECT id,role,status,specialist_id,version FROM staff_users
       WHERE id IN (?,?) ORDER BY id`,
    ).bind(anna.id, justyna.id).all()).results).toEqual(before)
  })

  it('rejects nonreciprocal disabled claims and archived desired profiles', async () => {
    await useScenario('MATERIALIZER_INVALID')
    const julia = await seedStaff({
      id: 'stf_materializer_julia_invalid_claim',
      displayName: 'Julia Wolanin',
      role: 'owner',
      specialistId: 'sp_staging_workbook_julia_wolanin',
    })
    const anna = await seedStaff({
      id: 'stf_materializer_anna_disabled',
      displayName: 'Anna Konto',
      role: 'owner',
      status: 'disabled',
      specialistId: 'sp_staging_workbook_anna_janowska',
    })
    await seedDesiredProfiles({ juliaStaff: julia })
    await expect(noCommands()(input())).rejects.toThrow('STAGING_SEED_INVALID')

    await run(
      `UPDATE specialists
       SET status='archived',version=version+1,archived_at=?,updated_at=?
       WHERE id='sp_staging_workbook_anna_janowska' AND version=1`,
      new Date(NOW_MS + 1_000).toISOString(),
      new Date(NOW_MS + 1_000).toISOString(),
    )
    await expect(noCommands()(input())).rejects.toThrow('STAGING_SEED_INVALID')
  })

  it('rejects deterministic-ID/name disagreement and duplicate canonical profile names', async () => {
    await useScenario('MATERIALIZER_CONFLICT')
    await seedStaff({
      id: 'stf_materializer_julia_name_conflict',
      displayName: 'Julia Wolanin',
      role: 'owner',
    })
    await seedProfile({
      id: 'sp_staging_workbook_julia_wolanin',
      displayName: 'Inny Profil',
    })
    await seedProfile({ id: next('sp_duplicate'), displayName: 'Julia Wolanin' })
    await seedProfile({ id: next('sp_duplicate'), displayName: 'Julia Wolanin' })
    await expect(noCommands()(input())).rejects.toThrow('STAGING_SEED_INVALID')
  })

  it('creates every missing profile before linking Julia last and converges on replay', async () => {
    await useScenario('MATERIALIZER_CREATE')
    const julia = await seedStaff({
      id: 'stf_materializer_julia_create',
      displayName: 'Julia Wolanin',
      role: 'owner',
    })
    const harness = directCommands()
    await expect(harness.materialize(input())).resolves.toEqual({
      created: 3, updated: 0, linked: 1, confirmed: 0,
    })
    expect(harness.calls.create).toHaveLength(3)
    expect(harness.calls.update).toHaveLength(0)
    expect(harness.calls.link).toHaveLength(1)
    expect(harness.calls.link[0].actor).toMatchObject({
      id: julia.id, role: 'owner', specialistId: null, version: 1,
    })
    expect(harness.calls.create.every((call) => (
      call.body.professionalTitle === 'Specjalistka'
      && !call.idempotencyKey.includes('Julia')
      && !call.idempotencyKey.includes('Anna')
      && !call.idempotencyKey.includes('Justyna')
    ))).toBe(true)
    expect(await activeDb.prepare(
      'SELECT role,status,specialist_id,version FROM staff_users WHERE id=?',
    ).bind(julia.id).first()).toEqual({
      role: 'owner', status: 'active',
      specialist_id: 'sp_staging_workbook_julia_wolanin', version: 2,
    })

    await expect(harness.materialize(input())).resolves.toEqual({
      created: 0, updated: 0, linked: 0, confirmed: 4,
    })
    expect(harness.calls.create).toHaveLength(3)
    expect(harness.calls.link).toHaveLength(1)
    expect((await activeDb.prepare(
      `SELECT count(*) AS count FROM specialist_account_links
       WHERE specialist_id='sp_staging_workbook_julia_wolanin'
         AND lifecycle='activated'`,
    ).first()).count).toBe(1)

    await expect(ensureStagingSpecialistProfiles({
      env: {
        ...env,
        APP_ENV: 'staging',
        APP_ORIGIN: 'https://staging.bearwithme-panel.app',
        DATA_MODE: 'fictional',
        DB: activeDb,
      },
      scheduledTime: NOW_MS,
    })).resolves.toEqual({
      created: 0, updated: 0, linked: 0, confirmed: 4,
    })
  })

  it('backfills a legacy Julia title/rate through the normal edit before link', async () => {
    await useScenario('MATERIALIZER_UPDATE')
    const julia = await seedStaff({
      id: 'stf_materializer_julia_update',
      displayName: 'Julia Wolanin',
      role: 'owner',
    })
    await seedDesiredProfiles({ juliaTitle: null, juliaRate: 19000 })
    const harness = directCommands()
    await expect(harness.materialize(input())).resolves.toEqual({
      created: 0, updated: 1, linked: 1, confirmed: 2,
    })
    expect(harness.calls.update).toHaveLength(1)
    expect(harness.calls.update[0]).toMatchObject({
      specialistId: 'sp_staging_workbook_julia_wolanin',
      actor: { id: julia.id, role: 'owner', version: 1 },
      body: {
        expectedVersion: 1,
        displayName: 'Julia Wolanin',
        professionalTitle: 'Specjalistka',
        standardRateGrosze: 18000,
      },
    })
    expect(harness.calls.link[0].body).toMatchObject({
      expectedSpecialistVersion: 2,
      expectedStaffVersion: 1,
    })
    const profile = await activeDb.prepare(
      `SELECT professional_title_envelope,standard_rate_grosze,staff_user_id,version
       FROM specialists WHERE id='sp_staging_workbook_julia_wolanin'`,
    ).first()
    expect(profile).toMatchObject({
      standard_rate_grosze: 18000,
      staff_user_id: julia.id,
      version: 3,
    })
    expect(await decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
      expectedScope: SCOPE,
      recordId: 'sp_staging_workbook_julia_wolanin',
      field: 'professional_title',
      envelope: JSON.parse(profile.professional_title_envelope),
    })).toBe('Specjalistka')
  })
})
