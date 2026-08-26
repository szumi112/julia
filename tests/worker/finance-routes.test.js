import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  appendFinanceImportChunk,
  commitFinanceImport,
  listFinanceEntries,
  startFinanceImport,
} from '../../worker/core/finance.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { createApp } from '../../worker/app.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = 1_800_000_000_000
const NOW = new Date(NOW_MS).toISOString()
const CORRELATION_ID = '00000000-0000-4000-8000-000000000031'
const OWNER = Object.freeze({ id: 'stf_finance_api_owner', role: 'owner', specialistId: null })
const COORDINATOR = Object.freeze({
  id: 'stf_finance_api_coord', role: 'coordinator', specialistId: null,
})
const SPECIALIST = Object.freeze({
  id: 'stf_finance_api_spec', role: 'specialist', specialistId: 'sp_finance_api',
})

const ring = () => createKeyring(env, {
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
  activeBackupKekVersion: 1,
})

let serial = 0
const ids = () => {
  const marker = ++serial
  const values = [
    `finance_batch_${marker}`,
    `finance_key_${marker}`,
    `finance_audit_${marker}_start`,
    `finance_entry_${marker}_one`,
    `finance_entry_${marker}_two`,
    `finance_chunk_${marker}`,
    `finance_audit_${marker}_chunk`,
    `finance_audit_${marker}_commit`,
  ]
  return () => values.shift()
}

const entry = (batchId, patch = {}) => {
  const { rowNumber = 2, ...overrides } = patch
  return ({
  kind: 'income',
  recordType: 'income',
  accountingMonth: '2025-09',
  occurredOn: '2025-09-08',
  amountGrosze: 18_000,
  paidAmountGrosze: 18_000,
  paymentMethod: 'card',
  settlementStatus: 'paid',
  invoiceStatus: 'issued',
  counterparty: 'Fikcyjna Klientka',
  sourceLabel: 'Konsultacja fikcyjna',
  invoiceNote: 'Fikcyjna faktura',
  specialistId: null,
  lessonCount: null,
  source: {
    batchId,
    sourceKey: `fictional.xlsx:Wrzesień:${rowNumber}:abcdef0123456789`,
    sheet: 'Wrzesień',
    rowNumber,
    raw: { Klient: 'Fikcyjna Klientka', Cena: 180 },
  },
  ...overrides,
  })
}

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      OWNER.id, 'finance_owner_lookup', '{}', '{}', 'owner', 'active',
      'finance-owner-subject', null, 1, NOW, null, NOW, NOW,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      COORDINATOR.id, 'finance_coord_lookup', '{}', '{}', 'coordinator', 'active',
      'finance-coord-subject', null, 1, NOW, null, NOW, NOW,
    ),
  ])
})

describe('protected finance import and read service', () => {
  it('accepts the versioned actor shape resolved by the HTTP identity boundary', async () => {
    const listed = await listFinanceEntries({
      db: env.DB, actor: { ...OWNER, version: 1 }, keyring: await ring(), nowMs: NOW_MS,
      month: '2026-08', kind: null,
    })

    expect(listed.data).toEqual({
      entries: [],
      summary: {
        month: '2026-08', revenueGrosze: 0, expensesGrosze: 0, balanceGrosze: 0,
        collectedGrosze: 0, outstandingGrosze: 0, invoiceActionCount: 0, entryCount: 0,
      },
    })
  })

  it('imports encrypted fictional rows, commits only a complete batch, and summarizes a month', async () => {
    const idFactory = ids()
    const keyring = await ring()
    const started = await startFinanceImport({
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory,
      body: {
        filename: 'fictional.xlsx', fingerprint: 'a'.repeat(64),
        formatVersion: 1, totalRows: 2,
      },
      idempotencyKey: 'finance-start-key-0001',
    })
    const batchId = started.body.data.batch.id
    expect(started).toMatchObject({
      status: 201,
      body: { data: { batch: { id: batchId, acceptedRows: 0, status: 'importing' } } },
    })

    await expect(commitFinanceImport({
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS + 1,
      correlationId: CORRELATION_ID, idFactory,
      batchId, body: { expectedVersion: 1 }, idempotencyKey: 'finance-commit-early-0001',
    })).rejects.toThrow('FINANCE_IMPORT_INCOMPLETE')

    const chunkBody = {
      sequence: 0,
      entries: [
        entry(batchId),
        entry(batchId, {
          rowNumber: 3, kind: 'expense', recordType: 'expense', amountGrosze: 4_000,
          paidAmountGrosze: 4_000, paymentMethod: 'transfer', invoiceStatus: 'not_required',
          counterparty: 'Fikcyjny koszt', sourceLabel: 'Materiały fikcyjne',
          invoiceNote: '', source: {
            batchId, sourceKey: 'fictional.xlsx:Wrzesień:3:abcdef0123456789',
            sheet: 'Wrzesień', rowNumber: 3, raw: { Koszt: 'Materiały fikcyjne' },
          },
        }),
      ],
    }
    const chunk = await appendFinanceImportChunk({
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS + 2,
      correlationId: CORRELATION_ID, idFactory,
      batchId, body: chunkBody, idempotencyKey: 'finance-chunk-key-0001',
    })
    expect(chunk.body.data.batch).toMatchObject({ acceptedRows: 2, version: 2 })
    expect((await appendFinanceImportChunk({
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS + 3,
      correlationId: CORRELATION_ID, idFactory,
      batchId, body: chunkBody, idempotencyKey: 'finance-chunk-key-0001',
    })).body).toEqual(chunk.body)

    const committed = await commitFinanceImport({
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS + 4,
      correlationId: CORRELATION_ID, idFactory,
      batchId, body: { expectedVersion: 2 }, idempotencyKey: 'finance-commit-key-0001',
    })
    expect(committed.body.data.batch).toMatchObject({ status: 'committed', version: 3 })

    const listed = await listFinanceEntries({
      db: env.DB, actor: COORDINATOR, keyring, nowMs: NOW_MS + 5,
      month: '2025-09', kind: null,
    })
    expect(listed.data.summary).toEqual({
      month: '2025-09', revenueGrosze: 18_000, expensesGrosze: 4_000,
      balanceGrosze: 14_000, collectedGrosze: 18_000,
      outstandingGrosze: 0, invoiceActionCount: 0, entryCount: 2,
    })
    expect(listed.data.entries.map(({ counterparty }) => counterparty).sort())
      .toEqual(['Fikcyjna Klientka', 'Fikcyjny koszt'])

    const stored = (await env.DB.prepare(
      'SELECT details_envelope,source_row_envelope FROM finance_entries WHERE batch_id=?'
    ).bind(batchId).all()).results
    expect(JSON.stringify(stored)).not.toContain('Fikcyjna Klientka')
    expect(JSON.stringify(stored)).not.toContain('Materiały fikcyjne')
  })

  it('allows owner-only mutation and denies specialists all centre finance reads', async () => {
    const keyring = await ring()
    for (const actor of [COORDINATOR, SPECIALIST]) {
      await expect(startFinanceImport({
        db: env.DB, actor, keyring, nowMs: NOW_MS,
        correlationId: CORRELATION_ID, idFactory: ids(),
        body: {
          filename: 'denied.xlsx', fingerprint: 'f'.repeat(64),
          formatVersion: 1, totalRows: 1,
        },
        idempotencyKey: 'finance-denied-key-0001',
      })).rejects.toThrow('NOT_FOUND')
    }
    await expect(listFinanceEntries({
      db: env.DB, actor: SPECIALIST, keyring, nowMs: NOW_MS,
      month: '2025-09', kind: null,
    })).rejects.toThrow('NOT_FOUND')
  })

  it('dispatches finance reads and imports through the authenticated closed HTTP shell', async () => {
    const list = async (input) => ({
      data: { entries: [], summary: {
        month: input.month, revenueGrosze: 0, expensesGrosze: 0, balanceGrosze: 0,
        collectedGrosze: 0, outstandingGrosze: 0, invoiceActionCount: 0, entryCount: 0,
      } },
    })
    const start = async (input) => ({ status: 201, body: { data: { batch: {
      id: 'fib_http_one', fingerprint: input.body.fingerprint,
      filename: input.body.filename, formatVersion: 1, totalRows: 1,
      acceptedRows: 0, status: 'importing', version: 1,
      createdAt: NOW, updatedAt: NOW, committedAt: null,
    } } } })
    const app = createApp({
      db: env.DB,
      config: {
        appEnv: 'staging', appOrigin: 'https://bearwithme-panel.app',
        dataMode: 'fictional',
      },
      cryptoContext: { keyring: await ring(), dataKey: {}, scope: {} },
      resolveAccessPrincipal: async () => ({
        kind: 'human', subject: 'finance-http-subject',
        normalizedEmail: 'finance-http@example.test',
      }),
      resolveActor: async () => ({ ...OWNER, version: 1 }),
      verifyCsrfToken: async () => true,
      readJsonBodyOnce: async (request) => request.json(),
      listFinanceEntries: list,
      startFinanceImport: start,
      now: () => NOW_MS,
    })
    const read = await app.request('/api/v1/finance?month=2025-09')
    expect(read.status).toBe(200)
    expect((await read.json()).data.summary.month).toBe('2025-09')

    const created = await app.request('/api/v1/finance/imports', {
      method: 'POST',
      headers: {
        origin: 'https://bearwithme-panel.app', 'content-type': 'application/json',
        'x-csrf-token': 'valid', 'idempotency-key': 'finance-http-key-0001',
      },
      body: JSON.stringify({
        filename: 'fictional.xlsx', fingerprint: 'e'.repeat(64),
        formatVersion: 1, totalRows: 1,
      }),
    })
    expect(created.status).toBe(201)
    expect((await created.json()).data.batch.id).toBe('fib_http_one')
  })
})
