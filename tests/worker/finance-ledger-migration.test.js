import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const now = '2026-08-27T10:00:00.000Z'

const run = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).run()
const all = async (sql, ...bindings) => (
  await env.DB.prepare(sql).bind(...bindings).all()
).results

const insertBatch = (patch = {}) => {
  const value = {
    id: 'fib_migration_one',
    fingerprint: 'a'.repeat(64),
    filenameEnvelope: '{}',
    formatVersion: 1,
    totalRows: 2,
    acceptedRows: 0,
    status: 'importing',
    createdBy: 'stf_finance_owner',
    version: 1,
    createdAt: now,
    updatedAt: now,
    committedAt: null,
    ...patch,
  }
  return run(
    `INSERT INTO finance_import_batches
     (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,
      status,created_by_staff_id,version,created_at,updated_at,committed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    value.id, value.fingerprint, value.filenameEnvelope, value.formatVersion,
    value.totalRows, value.acceptedRows, value.status, value.createdBy,
    value.version, value.createdAt, value.updatedAt, value.committedAt,
  )
}

const insertEntry = (patch = {}) => {
  const value = {
    id: 'fin_migration_one',
    batchId: 'fib_migration_one',
    sourceKey: 'source.xlsx:Wrzesień:2:0123456789abcdef',
    kind: 'income',
    recordType: 'income',
    accountingMonth: '2025-09',
    occurredOn: '2025-09-08',
    amountGrosze: 18000,
    paidAmountGrosze: 18000,
    method: 'card',
    settlement: 'paid',
    invoice: 'issued',
    specialistId: null,
    appointmentId: null,
    counterpartyLookup: null,
    detailsEnvelope: '{}',
    sourceRowEnvelope: '{}',
    version: 1,
    createdBy: 'stf_finance_owner',
    createdAt: now,
    updatedAt: now,
    ...patch,
  }
  return run(
    `INSERT INTO finance_entries
     (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
      amount_grosze,paid_amount_grosze,payment_method,settlement_status,
      invoice_status,specialist_id,appointment_id,counterparty_lookup,
      details_envelope,source_row_envelope,version,created_by_staff_id,
      created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    value.id, value.batchId, value.sourceKey, value.kind, value.recordType,
    value.accountingMonth, value.occurredOn, value.amountGrosze,
    value.paidAmountGrosze, value.method, value.settlement, value.invoice,
    value.specialistId, value.appointmentId, value.counterpartyLookup,
    value.detailsEnvelope, value.sourceRowEnvelope, value.version,
    value.createdBy, value.createdAt, value.updatedAt,
  )
}

describe('finance ledger migration', () => {
  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await applyFinanceStageC()
    await run(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,
        access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at)
       VALUES ('stf_finance_owner',?,'{}','{}','owner','active',
               'subject-finance-owner',NULL,1,?,NULL,?,?)`,
      'b'.repeat(43), now, now, now,
    )
  })

  it('applies stage C and creates the exact finance columns', async () => {
    expect(await all(
      "SELECT name FROM d1_migrations WHERE name='0012_finance_ledger.sql'"
    )).toEqual([{ name: '0012_finance_ledger.sql' }])
    const expected = {
      finance_adjustments: ['id', 'finance_entry_id', 'reason_envelope', 'before_envelope', 'after_envelope', 'recorded_by_staff_id', 'created_at'],
      finance_entries: ['id', 'batch_id', 'source_key', 'kind', 'record_type', 'accounting_month', 'occurred_on', 'amount_grosze', 'paid_amount_grosze', 'currency', 'payment_method', 'settlement_status', 'invoice_status', 'specialist_id', 'appointment_id', 'counterparty_lookup', 'details_envelope', 'source_row_envelope', 'version', 'created_by_staff_id', 'created_at', 'updated_at'],
      finance_import_batches: ['id', 'fingerprint', 'filename_envelope', 'format_version', 'total_rows', 'accepted_rows', 'status', 'created_by_staff_id', 'version', 'created_at', 'updated_at', 'committed_at'],
      finance_import_chunks: ['id', 'batch_id', 'sequence', 'row_count', 'payload_hash', 'idempotency_key', 'created_at'],
    }
    for (const [table, columns] of Object.entries(expected)) {
      expect((await all(`PRAGMA table_info(${table})`)).map(({ name }) => name))
        .toEqual(columns)
    }
  })

  it('accepts a valid imported row and defaults currency to PLN', async () => {
    await insertBatch()
    await insertEntry()
    expect(await all(
      "SELECT currency,version FROM finance_entries WHERE id='fin_migration_one'"
    )).toEqual([{ currency: 'PLN', version: 1 }])
  })

  it('rejects invalid kinds, states, dates, amounts, and settlement relationships', async () => {
    const cases = [
      { id: 'fin_bad_kind', kind: 'refund' },
      { id: 'fin_bad_record_type', recordType: 'appointment' },
      { id: 'fin_bad_month', accountingMonth: '2025-13' },
      { id: 'fin_bad_date', occurredOn: '2025-02-30' },
      { id: 'fin_bad_amount', amountGrosze: -1 },
      { id: 'fin_bad_paid', paidAmountGrosze: 17000, settlement: 'paid' },
      { id: 'fin_bad_method', method: 'crypto' },
      { id: 'fin_bad_invoice', invoice: 'maybe' },
    ]
    for (const value of cases) await expect(insertEntry(value)).rejects.toThrow()
  })

  it('accepts unknown periods and zero-value English rows only', async () => {
    await insertEntry({
      id: 'fin_unknown_period', sourceKey: 'unknown-period',
      accountingMonth: null, occurredOn: null,
    })
    await insertEntry({
      id: 'fin_zero_english', sourceKey: 'zero-english', recordType: 'english',
      amountGrosze: 0, paidAmountGrosze: 0, settlement: 'unknown',
    })
    await expect(insertEntry({
      id: 'fin_zero_income', sourceKey: 'zero-income', amountGrosze: 0,
      paidAmountGrosze: 0, settlement: 'unknown',
    })).rejects.toThrow()
  })

  it('deduplicates source rows and import chunks without blocking manual rows', async () => {
    await expect(insertEntry({ id: 'fin_duplicate_source' })).rejects.toThrow()
    await run(
      `INSERT INTO finance_entries
       (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
        amount_grosze,paid_amount_grosze,payment_method,settlement_status,
        invoice_status,specialist_id,appointment_id,counterparty_lookup,
        details_envelope,source_row_envelope,version,created_by_staff_id,
        created_at,updated_at)
       VALUES ('fin_manual_one',NULL,NULL,'expense','expense',NULL,NULL,
               30000,30000,'transfer','paid','not_required',NULL,NULL,NULL,
               '{}',NULL,1,'stf_finance_owner',?,?)`,
      now, now,
    )
    await run(
      `INSERT INTO finance_import_chunks
       (id,batch_id,sequence,row_count,payload_hash,idempotency_key,created_at)
       VALUES ('fic_chunk_one','fib_migration_one',0,2,?,'key-one',?)`,
      'c'.repeat(64), now,
    )
    await expect(run(
      `INSERT INTO finance_import_chunks
       (id,batch_id,sequence,row_count,payload_hash,idempotency_key,created_at)
       VALUES ('fic_chunk_two','fib_migration_one',0,2,?,'key-two',?)`,
      'd'.repeat(64), now,
    )).rejects.toThrow()
  })

  it('keeps adjustments append-only and requires entry version increments', async () => {
    await run(
      `INSERT INTO finance_adjustments
       (id,finance_entry_id,reason_envelope,before_envelope,after_envelope,
        recorded_by_staff_id,created_at)
       VALUES ('fadj_one','fin_migration_one','{}','{}','{}','stf_finance_owner',?)`,
      now,
    )
    await expect(run(
      "UPDATE finance_adjustments SET reason_envelope='changed' WHERE id='fadj_one'"
    )).rejects.toThrow()
    await expect(run(
      "UPDATE finance_entries SET amount_grosze=19000 WHERE id='fin_migration_one'"
    )).rejects.toThrow()
    await run(
      `UPDATE finance_entries
       SET amount_grosze=19000,paid_amount_grosze=19000,version=2,updated_at=?
       WHERE id='fin_migration_one'`,
      '2026-08-27T10:01:00.000Z',
    )
  })
})
