import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW = '2027-06-15T10:00:00.000Z'
let failure

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyD1Migrations(env.DB, env.TEST_STAGE_E_MIGRATIONS.filter(({ name }) => (
    name !== '0021_finance_reporting_registry.sql'
  )))
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'stf_duplicate_backfill', 'duplicate_backfill_lookup', '{}', '{}', 'owner',
    'active', 'duplicate-backfill-subject', null, 1, NOW, null, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,professional_title_envelope,
     standard_rate_grosze,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
    'sp_duplicate_backfill', null, '{}', '{}', 18_000, 'active', 1, null, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO clients
    (id,identity_envelope,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).bind(
    'cl_duplicate_backfill', '{}', 'active', 1, null, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO appointments
    (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
     status,source,version,cancelled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'apt_duplicate_backfill', 'cl_duplicate_backfill', 'sp_duplicate_backfill',
    'zajecia', '2027-06-15T08:00:00.000Z', '2027-06-15T08:50:00.000Z',
    'Europe/Warsaw', null, 'completed', 'panel', 1, null, NOW, NOW,
  ).run()
  for (const suffix of ['a', 'b']) await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    `fin_duplicate_backfill_${suffix}`, null, null, 'income', 'income', '2027-06',
    '2027-06-15', 18_000, 0, 'unknown', 'unpaid', 'not_required',
    'sp_duplicate_backfill', 'apt_duplicate_backfill', null, '{}', null, 1,
    'stf_duplicate_backfill', NOW, NOW,
  ).run()
  const migration = env.TEST_STAGE_E_MIGRATIONS.find(({ name }) => (
    name === '0021_finance_reporting_registry.sql'
  ))
  try { await applyD1Migrations(env.DB, [migration]) } catch (error) { failure = error }
})

describe('0021 legacy duplicate appointment preflight', () => {
  it('fails closed with a deterministic authority error before choosing an economic winner', () => {
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('duplicate_active_finance_appointment_authority')
  })
})
