import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import { loadFinanceWindow as loadFinanceWindowCore } from '../../worker/core/finance-reporting.js'
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
const OWNER = authorityActor({ id: 'stf_finance_snapshot_owner', role: 'owner' })
const loadFinanceWindow = (input) => loadFinanceWindowCore({ ...input, keyring: {} })

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
    OWNER.id, 'finance_snapshot_owner_lookup', '{}', '{}', 'owner', 'active',
    'finance-snapshot-owner-subject', null, 1, NOW, null, NOW, NOW,
  ).run()
})

describe('FinanceWindow revision bracket', () => {
  it('fails the whole snapshot when a covered finance mutation interleaves', async () => {
    let interleaved = false
    const db = {
      prepare(sql) {
        const statement = env.DB.prepare(sql)
        if (!sql.includes('JOIN finance_reporting_classifications AS classification')) {
          return statement
        }
        return {
          bind(...bindings) {
            const bound = statement.bind(...bindings)
            return {
              async all() {
                if (!interleaved) {
                  interleaved = true
                  await env.DB.prepare(`INSERT INTO finance_entries
                    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
                     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
                     invoice_status,specialist_id,appointment_id,counterparty_lookup,
                     details_envelope,source_row_envelope,version,created_by_staff_id,
                     created_at,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
                    'fin_finance_snapshot_interleaved', null, null, 'income', 'income',
                    '2027-06', '2027-06-15', 1, 0, 'unknown', 'unpaid',
                    'not_required', null, null, null, '{}', null, 1, OWNER.id, NOW, NOW,
                  ).run()
                }
                return bound.all()
              },
            }
          },
        }
      },
    }
    await expect(loadFinanceWindow({
      db, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-06',
    })).rejects.toThrow(/^FINANCE_WINDOW_RETRY$/)
    expect(interleaved).toBe(true)
  })

  it('fails the whole snapshot when source precision becomes linked mid-read', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_artifacts
        (id,centre_id,environment,fingerprint,byte_size,parser_version,
         materializer_version,object_key,content_nonce_b64,workbook_kek_version,
         metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wba_finance_snapshot_link', 'centre_1', 'staging', '9'.repeat(64), 64,
        2, 2, 'workbook-objects/wbo_finance_snapshot_link', 'A'.repeat(16),
        1, 1, 'B'.repeat(43), OWNER.id, NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_imports
        (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
         correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wbi_finance_snapshot_link', 'wba_finance_snapshot_link', 'C'.repeat(43),
        'complete', 1, 0, 'corr_finance_snapshot_link', OWNER.id, 1,
        NOW, NOW, NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_source_records
        (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
         record_type,disposition,accounting_month,occurred_on,period_precision,
         period_month,amount_grosze,payment_method,settlement_status,invoice_status,
         initial_paid_amount_grosze,record_digest,record_digest_hmac_version,
         specialist_source_digest,specialist_source_hmac_version,warning_codes_json,
         source_payload_version,source_payload_envelope,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wbs_finance_snapshot_link', 'wbi_finance_snapshot_link',
        'workbook:v1:0:72:0', 0, 'Fikcyjny arkusz', 72, 0, 'income', 'accepted',
        '2027-06', '2027-06-15', 'day', '2027-06', 18_000, 'unknown', 'unpaid',
        'not_required', 0, 'D'.repeat(43), 1, 'E'.repeat(43), 1, '[]', 1, '{}', NOW,
      ),
      env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,
         invoice_status,specialist_id,appointment_id,counterparty_lookup,
         details_envelope,source_row_envelope,version,created_by_staff_id,
         created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'fin_finance_snapshot_link', null, null, 'income', 'income', '2027-06',
        '2027-06-15', 18_000, 0, 'unknown', 'unpaid', 'not_required', null, null,
        null, '{}', null, 1, OWNER.id, NOW, NOW,
      ),
    ])
    let interleaved = false
    const db = {
      prepare(sql) {
        const statement = env.DB.prepare(sql)
        if (!sql.includes('JOIN finance_reporting_classifications AS classification')) {
          return statement
        }
        return {
          bind(...bindings) {
            const bound = statement.bind(...bindings)
            return {
              async all() {
                if (!interleaved) {
                  interleaved = true
                  await env.DB.prepare(`INSERT INTO finance_source_links
                    (id,source_record_id,finance_entry_id,relationship,
                     created_by_staff_id,created_at) VALUES (?,?,?,?,?,?)`).bind(
                    'fsl_finance_snapshot_link', 'wbs_finance_snapshot_link',
                    'fin_finance_snapshot_link', 'materialized', OWNER.id, NOW,
                  ).run()
                }
                return bound.all()
              },
            }
          },
        }
      },
    }

    await expect(loadFinanceWindow({
      db, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-06',
    })).rejects.toThrow(/^FINANCE_WINDOW_RETRY$/)
    expect(interleaved).toBe(true)
  })

  it('withholds a completed snapshot when current authority changes during the read', async () => {
    let revoked = false
    const db = {
      prepare(sql) {
        const statement = env.DB.prepare(sql)
        if (sql.includes('ORDER BY entry.accounting_month DESC,entry.id DESC LIMIT 1')) {
          return {
            bind(...bindings) {
              const bound = statement.bind(...bindings)
              return {
                async first(column) {
                  const result = await bound.first(column)
                  revoked = true
                  return result
                },
              }
            },
          }
        }
        if (sql.includes('SELECT authority.revision AS authority_revision')) {
          return {
            bind(...bindings) {
              const bound = statement.bind(...bindings)
              return { async all() { return revoked ? { results: [] } : bound.all() } }
            },
          }
        }
        return statement
      },
    }

    await expect(loadFinanceWindow({
      db, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-06',
    })).rejects.toThrow(/^NOT_FOUND$/)
    expect(revoked).toBe(true)
  })
})
