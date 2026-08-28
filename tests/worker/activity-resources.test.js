import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  parseActivityWorkspaceQuery,
  readActivityWorkspace,
} from '../../worker/core/activities.js'
import {
  ACTIVITY_SCOPE,
  encryptActivityIdentity,
} from '../../worker/core/activity-crypto.js'
import {
  createD1QueryBudget,
  usageForD1QueryBudgetViews,
} from '../../worker/db/query-budget.js'
import { getOrCreateDataKey } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = Date.parse('2026-08-15T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const owner = Object.freeze({
  id: 'stf_activity_read_owner', role: 'owner', specialistId: null, version: 1,
})
const specialist = Object.freeze({
  id: 'stf_activity_read_own', role: 'specialist',
  specialistId: 'sp_activity_read_own', version: 1,
})
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
let keyring
let dataKey

const insertParticipant = async (id, programId, name) => env.DB.prepare(
  `INSERT INTO activity_participants
   (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
    created_at,updated_at) VALUES (?,?,?,NULL,NULL,'active',1,?,?)`,
).bind(
  id, programId, await encryptActivityIdentity(keyring, dataKey, {
    kind: 'participant', id, programId, value: name,
  }), NOW, NOW,
).run()

const insertGroup = async (id, label) => env.DB.prepare(
  `INSERT INTO activity_groups
   (id,program_id,label_envelope,details_envelope,status,version,created_at,updated_at)
   VALUES (?,'apg_tus',?,NULL,'active',1,?,?)`,
).bind(id, await encryptActivityIdentity(keyring, dataKey, {
  kind: 'group', id, programId: 'apg_tus', value: label,
}), NOW, NOW).run()

const insertEnglishCharge = async ({ id, participantId, month, specialistId }) => {
  const financeId = `fin_${id.slice(4)}`
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
       specialist_id,appointment_id,counterparty_lookup,details_envelope,
       source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,NULL,NULL,'income','english',?,NULL,12000,6000,'transfer','partial',
       'not_required',?,NULL,NULL,'{}',NULL,1,?,?,?)`).bind(
      financeId, month, specialistId, owner.id, NOW, NOW,
    ),
    env.DB.prepare(`INSERT INTO activity_charges
      (id,participant_id,program_id,group_id,membership_id,period_precision,
       occurred_on,accounting_month,lesson_count,responsible_specialist_id,
       finance_entry_id,status,version,created_at,updated_at)
      VALUES (?,?,'apg_english',NULL,NULL,'month',NULL,?,2,?,?,'active',1,?,?)`)
      .bind(id, participantId, month, specialistId, financeId, NOW, NOW),
  ])
}

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  keyring = await createKeyring({
    BWM_DATA_KEK_V1: key(31), BWM_LOOKUP_HMAC_V1: key(32),
  }, { activeDataKekVersion: 1, activeLookupKeyVersion: 1 })
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,'{}','{}','owner','active','activity-read-owner',NULL,1,
       ?,NULL,?,?)`).bind(owner.id, 'activity_read_owner_lookup', NOW, NOW, NOW),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,'{}','{}','specialist','active','activity-read-own',
       'sp_activity_read_own',1,?,NULL,?,?)`)
      .bind(specialist.id, 'activity_read_own_lookup', NOW, NOW, NOW),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES ('stf_activity_read_other','activity_read_other_lookup','{}','{}',
       'specialist','active','activity-read-other','sp_activity_read_other',1,
       ?,NULL,?,?)`).bind(NOW, NOW, NOW),
  ])
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
       archived_at,created_at,updated_at)
      VALUES ('sp_activity_read_own',?,'{}',18000,'active',1,NULL,?,?)`)
      .bind(specialist.id, NOW, NOW),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
       archived_at,created_at,updated_at)
      VALUES ('sp_activity_read_other','stf_activity_read_other','{}',18000,
       'active',1,NULL,?,?)`).bind(NOW, NOW),
  ])
  dataKey = await getOrCreateDataKey(env.DB, keyring, ACTIVITY_SCOPE, {
    id: 'key_activity_read', createdAt: NOW,
  })
  await insertGroup('agr_activity_read_led', 'Fikcyjna własna grupa')
  await insertGroup('agr_activity_read_old', 'Fikcyjna dawna grupa')
  await insertGroup('agr_activity_read_other', 'Fikcyjna obca grupa')
  await insertGroup('agr_activity_read_future', 'Fikcyjna przyszła grupa')
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO activity_group_leaders
      (id,group_id,specialist_id,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('agl_activity_read_led','agr_activity_read_led','sp_activity_read_own',
       '2025-01-01',NULL,'active',1,?,?)`).bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO activity_group_leaders
      (id,group_id,specialist_id,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('agl_activity_read_old','agr_activity_read_old','sp_activity_read_own',
       '2025-01-01','2025-12-31','active',1,?,?)`).bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO activity_group_leaders
      (id,group_id,specialist_id,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('agl_activity_read_other','agr_activity_read_other',
       'sp_activity_read_other','2025-01-01',NULL,'active',1,?,?)`).bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO activity_group_leaders
      (id,group_id,specialist_id,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('agl_activity_read_future','agr_activity_read_future',
       'sp_activity_read_own','2026-09-01',NULL,'active',1,?,?)`).bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO activity_classes
      (id,group_id,occurs_on,wall_time,duration_minutes,topic_envelope,status,
       version,created_at,updated_at)
      VALUES ('acl_activity_read_future','agr_activity_read_future','2026-10-15',
       '16:00',60,NULL,'scheduled',1,?,?)`).bind(NOW, NOW),
  ])
  await insertParticipant('acp_activity_read_led', 'apg_tus', 'Fikcyjna w grupie')
  await insertParticipant(
    'acp_activity_read_class_old', 'apg_tus', 'Fikcyjna dawna obecność',
  )
  await insertParticipant('acp_activity_read_old', 'apg_english', 'Fikcyjna dawna')
  await insertParticipant('acp_activity_read_other', 'apg_english', 'Fikcyjna obca')
  await insertParticipant('acp_activity_read_window', 'apg_english', 'Fikcyjna bieżąca')
  await insertParticipant(
    'acp_activity_read_observation_old', 'apg_tus', 'Fikcyjna dawna obserwacja',
  )
  await insertParticipant(
    'acp_activity_read_observation_attendance', 'apg_tus',
    'Fikcyjna obserwacja z obecnością',
  )
  await env.DB.prepare(`INSERT INTO activity_memberships
    (id,participant_id,program_id,group_id,membership_kind,period_precision,
     observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
    VALUES ('amb_activity_read_led','acp_activity_read_led','apg_tus',
     'agr_activity_read_led','interval','unknown',NULL,NULL,'2025-01-01',NULL,
     'active',1,?,?)`).bind(NOW, NOW).run()
  await env.DB.prepare(`INSERT INTO activity_memberships
    (id,participant_id,program_id,group_id,membership_kind,period_precision,
     observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
    VALUES ('amb_activity_read_future','acp_activity_read_led','apg_tus',
     'agr_activity_read_future','observation','month',NULL,'2026-10',NULL,NULL,
     'active',1,?,?)`).bind(NOW, NOW).run()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_activity_read_observation_attendance',
       'acp_activity_read_observation_attendance','apg_tus','agr_activity_read_led',
       'observation','month',NULL,'2025-08',NULL,NULL,'active',1,?,?)`).bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO activity_classes
      (id,group_id,occurs_on,wall_time,duration_minutes,topic_envelope,status,
       version,created_at,updated_at)
      VALUES ('acl_activity_read_observation_attendance','agr_activity_read_led',
       '2025-08-15','16:00',60,NULL,'completed',1,?,?)`).bind(NOW, NOW),
  ])
  await env.DB.prepare(`INSERT INTO activity_attendance
    (id,class_id,participant_id,status,version,created_at,updated_at)
    VALUES ('aat_activity_read_observation_attendance',
     'acl_activity_read_observation_attendance',
     'acp_activity_read_observation_attendance','present',1,?,?)`).bind(NOW, NOW).run()
  await env.DB.prepare(`UPDATE activity_memberships SET status='inactive',version=2,
    updated_at=? WHERE id='amb_activity_read_observation_attendance'`).bind(NOW).run()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_activity_read_class_old','acp_activity_read_class_old','apg_tus',
       'agr_activity_read_old','interval','unknown',NULL,NULL,'2025-01-01','2025-12-31',
       'active',1,?,?)`).bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO activity_classes
      (id,group_id,occurs_on,wall_time,duration_minutes,topic_envelope,status,
       version,created_at,updated_at)
      VALUES ('acl_activity_read_class_old','agr_activity_read_old','2025-07-15',
       '16:00',60,NULL,'completed',1,?,?)`).bind(NOW, NOW),
  ])
  await env.DB.prepare(`INSERT INTO activity_attendance
    (id,class_id,participant_id,status,version,created_at,updated_at)
    VALUES ('aat_activity_read_class_old','acl_activity_read_class_old',
     'acp_activity_read_class_old','present',1,?,?)`).bind(NOW, NOW).run()
  await env.DB.prepare(`INSERT INTO activity_memberships
    (id,participant_id,program_id,group_id,membership_kind,period_precision,
     observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
    VALUES ('amb_activity_read_observation_old','acp_activity_read_observation_old',
     'apg_tus','agr_activity_read_led','observation','month',NULL,'2025-01',NULL,NULL,
     'active',1,?,?)`).bind(NOW, NOW).run()
  await insertEnglishCharge({
    id: 'ach_activity_read_old', participantId: 'acp_activity_read_old',
    month: '2025-01', specialistId: 'sp_activity_read_own',
  })
  await insertEnglishCharge({
    id: 'ach_activity_read_other', participantId: 'acp_activity_read_other',
    month: '2026-07', specialistId: 'sp_activity_read_other',
  })
  await insertEnglishCharge({
    id: 'ach_activity_read_window', participantId: 'acp_activity_read_window',
    month: '2026-07', specialistId: 'sp_activity_read_own',
  })
  await insertEnglishCharge({
    id: 'ach_activity_read_future', participantId: 'acp_activity_read_window',
    month: '2026-10', specialistId: 'sp_activity_read_own',
  })
})

describe('scoped activity workspace resources', () => {
  it('parses an exact inclusive 12-month query and rejects duplicate/extra bounds', () => {
    expect(parseActivityWorkspaceQuery(
      'https://panel.example.test/api/v1/activities/workspace?from=2025-08&to=2026-07',
    )).toEqual({ from: '2025-08', to: '2026-07' })
    for (const url of [
      'https://panel.example.test/api/v1/activities/workspace?from=2025-08&to=2026-08',
      'https://panel.example.test/api/v1/activities/workspace?from=2026-07&to=2026-07&to=2026-08',
      'https://panel.example.test/api/v1/activities/workspace?from=2026-07&to=2026-07&extra=1',
    ]) expect(() => parseActivityWorkspaceQuery(url)).toThrow('VALIDATION_FAILED')
  })

  it('returns centre directories but only requested-month facts', async () => {
    const result = await readActivityWorkspace({
      db: env.DB, actor: owner, keyring, nowMs: NOW_MS,
      window: { from: '2026-07', to: '2026-07' },
    })
    expect(result.data.groups.map(({ id }) => id)).toEqual([
      'agr_activity_read_future', 'agr_activity_read_led', 'agr_activity_read_old',
      'agr_activity_read_other',
    ])
    expect(result.data.participants.map(({ id }) => id)).toEqual([
      'acp_activity_read_class_old', 'acp_activity_read_led',
      'acp_activity_read_observation_attendance',
      'acp_activity_read_observation_old',
      'acp_activity_read_old', 'acp_activity_read_other', 'acp_activity_read_window',
    ])
    expect(result.data.charges.map(({ id }) => id)).toEqual([
      'ach_activity_read_other', 'ach_activity_read_window',
    ])
    expect(result.data.payments).toEqual([])
    expect(result.data.currentDay).toBe('2026-08-15')
    expect(result.data.latestPopulatedMonths).toEqual({
      tus: '2025-01', english: '2026-07',
    })
  })

  it('keeps current led roster plus in-window own facts and hides old/other sentinels', async () => {
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const result = await readActivityWorkspace({
      db: budget.work, actor: specialist, keyring, nowMs: NOW_MS,
      window: { from: '2026-07', to: '2026-07' },
    })
    expect(result.data.groups.map(({ id }) => id)).toEqual(['agr_activity_read_led'])
    expect(result.data.participants.map(({ id }) => id)).toEqual([
      'acp_activity_read_led', 'acp_activity_read_window',
    ])
    expect(result.data.charges.map(({ id }) => id)).toEqual([
      'ach_activity_read_window',
    ])
    expect(JSON.stringify(result)).not.toContain('Fikcyjna dawna')
    expect(JSON.stringify(result)).not.toContain('Fikcyjna obca')
    expect(JSON.stringify(result)).not.toContain('Fikcyjna przyszła grupa')
    expect(JSON.stringify(result)).not.toContain('Fikcyjna dawna obserwacja')
    expect(JSON.stringify(result)).not.toContain('Fikcyjna dawna obecność')
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toMatchObject({
      used: 10, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('closes a historical led class over its attendance participant and interval only', async () => {
    const result = await readActivityWorkspace({
      db: env.DB, actor: specialist, keyring, nowMs: NOW_MS,
      window: { from: '2025-07', to: '2025-07' },
    })
    expect(result.data.groups.map(({ id }) => id)).toEqual([
      'agr_activity_read_led', 'agr_activity_read_old',
    ])
    expect(result.data.participants.map(({ id }) => id)).toEqual([
      'acp_activity_read_class_old', 'acp_activity_read_led',
    ])
    expect(result.data.memberships.map(({ id }) => id)).toEqual([
      'amb_activity_read_class_old', 'amb_activity_read_led',
    ])
    expect(result.data.classes.map(({ id }) => id)).toEqual([
      'acl_activity_read_class_old',
    ])
    expect(result.data.attendance.map(({ id }) => id)).toEqual([
      'aat_activity_read_class_old',
    ])
    expect(JSON.stringify(result)).not.toContain('Fikcyjna dawna obserwacja')
  })

  it('includes an inactive observation only when it closes returned historical attendance', async () => {
    const result = await readActivityWorkspace({
      db: env.DB, actor: specialist, keyring, nowMs: NOW_MS,
      window: { from: '2025-08', to: '2025-08' },
    })
    expect(result.data.participants.map(({ id }) => id)).toContain(
      'acp_activity_read_observation_attendance',
    )
    expect(result.data.memberships).toContainEqual(expect.objectContaining({
      id: 'amb_activity_read_observation_attendance', status: 'inactive',
      period: { precision: 'month', day: null, month: '2025-08' },
    }))
    expect(result.data.classes.map(({ id }) => id)).toContain(
      'acl_activity_read_observation_attendance',
    )
    expect(result.data.attendance.map(({ id }) => id)).toContain(
      'aat_activity_read_observation_attendance',
    )
  })

  it('returns future native classes while latest populated months remain current-capped facts', async () => {
    const result = await readActivityWorkspace({
      db: env.DB, actor: owner, keyring,
      nowMs: Date.parse('2026-08-31T22:30:00.000Z'),
      window: { from: '2026-09', to: '2026-10' },
    })
    expect(result).toMatchObject({
      data: {
        from: '2026-09', to: '2026-10',
        currentDay: '2026-09-01',
        latestPopulatedMonths: { tus: '2025-01', english: '2026-07' },
      },
    })
    expect(result.data.classes.map(({ id }) => id)).toEqual([
      'acl_activity_read_future',
    ])
    expect(result.data.memberships.map(({ id }) => id)).toContain(
      'amb_activity_read_future',
    )
    expect(result.data.charges.map(({ id }) => id)).toEqual([
      'ach_activity_read_future',
    ])
  })
})
