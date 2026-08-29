import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import { FINANCE_SCOPE } from '../../worker/core/finance.js'
import { voidFinanceEntry } from '../../worker/core/finance-reporting.js'
import { decryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2027-06-15T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const OWNER = authorityActor({ id: 'stf_finance_void_owner', role: 'owner' })
const CORRELATION_ID = '00000000-0000-4000-8000-000000000211'
let keyring
let financeKey

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    OWNER.id, 'finance_void_owner_lookup', '{}', '{}', 'owner', 'active',
    'finance-void-owner-subject', null, 1, NOW, null, NOW, NOW,
  ).run()
  keyring = await createKeyring(env, {
    activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
  })
  financeKey = await getOrCreateDataKey(env.DB, keyring, FINANCE_SCOPE, {
    id: 'key_finance_void', createdAt: NOW,
  })
  await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,professional_title_envelope,
     standard_rate_grosze,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
    'sp_finance_void_activity', null, '{}', '{}', 18_000, 'active', 1, null, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fin_finance_manual_void', null, null, 'income', 'income', '2027-06',
    '2027-06-15', 18_000, 0, 'unknown', 'unpaid', 'not_required', null, null,
    null, '{}', null, 1, OWNER.id, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO activity_participants
    (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
     created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    'acp_finance_void_activity', 'apg_english', '{}', null, null, 'active', 1, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fin_finance_void_activity', null, null, 'income', 'english', '2027-06',
    '2027-06-15', 0, 0, 'unknown', 'unpaid', 'not_required',
    'sp_finance_void_activity', null, null, '{}', null, 1, OWNER.id, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO activity_charges
    (id,participant_id,program_id,group_id,membership_id,period_precision,
     occurred_on,accounting_month,lesson_count,responsible_specialist_id,
     finance_entry_id,status,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'ach_finance_void_activity', 'acp_finance_void_activity', 'apg_english', null,
    null, 'day', '2027-06-15', '2027-06', 1, 'sp_finance_void_activity',
    'fin_finance_void_activity', 'active', 1, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO historical_clients
    (id,identity_envelope,status,active_client_id,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).bind(
    'hcl_finance_void_history', '{}', 'historical', null, 1, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_artifacts
    (id,centre_id,environment,fingerprint,byte_size,parser_version,
     materializer_version,object_key,content_nonce_b64,workbook_kek_version,
     metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'wba_finance_void_history', 'centre_1', 'staging', '5'.repeat(64), 4096, 2, 2,
    'workbook-objects/wbo_finance_void_history', 'A'.repeat(16), 1, 1,
    'B'.repeat(43), OWNER.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_imports
    (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
     correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'wbi_finance_void_history', 'wba_finance_void_history', 'C'.repeat(43),
    'ready', 1, 0, 'corr_finance_void_history', OWNER.id, 1, NOW, NOW, null,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_source_records
    (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
     record_type,disposition,accounting_month,occurred_on,period_precision,
     period_month,amount_grosze,payment_method,settlement_status,invoice_status,
     initial_paid_amount_grosze,record_digest,record_digest_hmac_version,
     specialist_source_digest,specialist_source_hmac_version,warning_codes_json,
     source_payload_version,source_payload_envelope,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'wbs_finance_void_history', 'wbi_finance_void_history', 'workbook:v1:0:2:0',
    0, 'Czerwiec', 2, 0, 'income', 'accepted', '2027-06', '2027-06-15',
    'day', '2027-06', 18_000, 'unknown', 'unpaid', 'not_required', 0,
    'D'.repeat(43), 1, 'E'.repeat(43), 1, '[]', 1, '{}', NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fin_finance_void_history', null, null, 'income', 'income', '2027-06',
    '2027-06-15', 18_000, 0, 'unknown', 'unpaid', 'not_required',
    'sp_finance_void_activity', null, null, '{}', null, 1, OWNER.id, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_source_links
    (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?)`).bind(
    'fsl_finance_void_history', 'wbs_finance_void_history',
    'fin_finance_void_history', 'materialized', OWNER.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO historical_client_source_links
    (id,historical_client_id,source_record_id,created_at) VALUES (?,?,?,?)`).bind(
    'hcs_finance_void_history', 'hcl_finance_void_history',
    'wbs_finance_void_history', NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO historical_service_occurrences
    (id,source_record_id,historical_client_id,counterparty_id,specialist_id,
     service_id,service_label_envelope,period_precision,occurred_on,occurred_month,
     status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'hoc_finance_void_history', 'wbs_finance_void_history',
    'hcl_finance_void_history', null, 'sp_finance_void_activity', 'zajecia', '{}',
    'day', '2027-06-15', '2027-06', 'recorded', 1, NOW, NOW,
  ).run()
  for (const id of ['fin_finance_void_concurrent', 'fin_finance_void_distinct']) {
    await env.DB.prepare(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, null, null, 'income', 'income', '2027-06', '2027-06-15', 18_000, 0,
      'unknown', 'unpaid', 'not_required', null, null, null, '{}', null, 1,
      OWNER.id, NOW, NOW,
    ).run()
  }
  await env.DB.prepare(`INSERT INTO finance_import_batches
    (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
     created_by_staff_id,version,created_at,updated_at,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fib_finance_void_materializing', '7'.repeat(64), '{}', 1, 1, 0, 'importing',
    OWNER.id, 1, NOW, NOW, null,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fin_finance_void_materializing', 'fib_finance_void_materializing', 'fictional-materializing',
    'income', 'income', '2027-06', '2027-06-15', 18_000, 0, 'unknown', 'unpaid',
    'not_required', null, null, null, '{}', '{}', 1, OWNER.id, NOW, NOW,
  ).run()
})

describe('audited manual finance void command', () => {
  it('uses a command-specific validation path', async () => {
    await expect(voidFinanceEntry({
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: () => 'must_not_generate',
      entryId: 'fin_finance_manual_void', expectedVersion: 1,
      reason: '', idempotencyKey: 'finance-void-invalid-211',
    })).rejects.toThrow(/^VALIDATION_FAILED\/financeVoid$/)
    for (const reason of ['Fikcyjna\u202E korekta', 'Fikcyjna korekta e\u0301']) {
      await expect(voidFinanceEntry({
        db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
        correlationId: CORRELATION_ID, idFactory: () => 'must_not_generate',
        entryId: 'fin_finance_manual_void', expectedVersion: 1,
        reason, idempotencyKey: 'finance-void-invalid-unicode-211',
      })).rejects.toThrow(/^VALIDATION_FAILED\/financeVoid$/)
    }
  })

  it('binds optimistic version, reason, audit and idempotent replay atomically', async () => {
    const ids = ['finance_manual_void', 'finance_void_audit']
    const command = {
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: () => ids.shift(),
      entryId: 'fin_finance_manual_void', expectedVersion: 1,
      reason: 'Fikcyjna pozycja została zaksięgowana podwójnie.',
      idempotencyKey: 'finance-void-replay-211',
    }
    const first = await voidFinanceEntry(command)
    const replay = await voidFinanceEntry({ ...command, idFactory: () => 'must_not_generate' })
    expect(first).toEqual(replay)
    const revokedDb = {
      prepare(sql) {
        if (sql.includes('FROM staff_authorities AS authority')) return {
          bind() { return this },
          async all() { return { results: [] } },
        }
        return env.DB.prepare(sql)
      },
      batch(statements) { return env.DB.batch(statements) },
    }
    await expect(voidFinanceEntry({
      ...command, db: revokedDb, idFactory: () => 'must_not_generate',
    })).rejects.toThrow(/^NOT_FOUND$/)
    expect(first).toEqual({ status: 200, body: { data: {
      entryId: 'fin_finance_manual_void', state: 'void', version: 1,
    } } })

    const row = await env.DB.prepare(
      'SELECT id,reason_envelope FROM finance_manual_voids WHERE finance_entry_id=?',
    ).bind('fin_finance_manual_void').first()
    expect(await decryptForScope(keyring, financeKey, {
      expectedScope: FINANCE_SCOPE, recordId: row.id, field: 'reason',
      envelope: JSON.parse(row.reason_envelope),
    })).toBe(command.reason)
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='finance.entry.voided'",
    ).first('count')).toBe(1)

    await expect(voidFinanceEntry({
      ...command, idempotencyKey: 'finance-void-stale-211',
      idFactory: () => 'must_not_generate',
    })).rejects.toThrow(/FINANCE_ENTRY_VOIDED|VERSION_CONFLICT/)
  })

  it('replays same-key concurrency and types a distinct-key same-entry loser', async () => {
    const command = (entryId, idempotencyKey, marker) => {
      const values = [`void_${marker}`, `audit_${marker}`]
      return {
        db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
        correlationId: CORRELATION_ID, idFactory: () => values.shift(),
        entryId, expectedVersion: 1, reason: 'Fikcyjny powód wycofania wpisu.',
        idempotencyKey,
      }
    }
    const same = await Promise.all([
      voidFinanceEntry(command(
        'fin_finance_void_concurrent', 'finance-void-concurrent-211', 'same_a',
      )),
      voidFinanceEntry(command(
        'fin_finance_void_concurrent', 'finance-void-concurrent-211', 'same_b',
      )),
    ])
    expect(same[0]).toEqual(same[1])

    const distinct = await Promise.allSettled([
      voidFinanceEntry(command(
        'fin_finance_void_distinct', 'finance-void-distinct-a-211', 'distinct_a',
      )),
      voidFinanceEntry(command(
        'fin_finance_void_distinct', 'finance-void-distinct-b-211', 'distinct_b',
      )),
    ])
    expect(distinct.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const loser = distinct.find(({ status }) => status === 'rejected')
    expect(loser.reason).toMatchObject({ message: 'FINANCE_ENTRY_VOIDED' })
  })

  it('rejects a ledger row whose import batch is not committed', async () => {
    await expect(voidFinanceEntry({
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: () => 'must_not_generate',
      entryId: 'fin_finance_void_materializing', expectedVersion: 1,
      reason: 'Fikcyjny powód wycofania wpisu.',
      idempotencyKey: 'finance-void-materializing-211',
    })).rejects.toThrow(/^FINANCE_ENTRY_NOT_READY$/)
  })

  it('atomically inactivates a linked activity charge before preserving the void', async () => {
    const values = ['finance_void_activity', 'finance_void_activity_audit']
    await voidFinanceEntry({
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: () => values.shift(),
      entryId: 'fin_finance_void_activity', expectedVersion: 1,
      reason: 'Fikcyjny program został rozliczony dwukrotnie.',
      idempotencyKey: 'finance-void-activity-211',
    })
    expect(await env.DB.prepare(
      "SELECT status,version FROM activity_charges WHERE id='ach_finance_void_activity'",
    ).first()).toEqual({ status: 'inactive', version: 2 })
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM finance_manual_voids
      WHERE finance_entry_id='fin_finance_void_activity'`).first('count')).toBe(1)
  })

  it('atomically voids a linked historical occurrence before preserving the source', async () => {
    const values = ['finance_void_history', 'finance_void_history_audit']
    await voidFinanceEntry({
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: () => values.shift(),
      entryId: 'fin_finance_void_history', expectedVersion: 1,
      reason: 'Fikcyjne zdarzenie historyczne zostało powielone.',
      idempotencyKey: 'finance-void-history-211',
    })
    expect(await env.DB.prepare(`SELECT status,version FROM historical_service_occurrences
      WHERE id='hoc_finance_void_history'`).first())
      .toEqual({ status: 'voided', version: 2 })
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM finance_source_links
      WHERE finance_entry_id='fin_finance_void_history'`).first('count')).toBe(1)
  })
})
