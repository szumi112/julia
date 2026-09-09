import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  continueHistoricalProjection,
  HISTORICAL_PROJECTION_SLICE_SIZE,
} from '../../worker/core/historical-materializer.js'
import { buildHistoricalIdentity } from '../../worker/core/historical-crypto.js'
import { encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  digestWorkbookSourcePayload,
  digestWorkbookSourceValue,
} from '../../worker/security/workbook-artifacts.js'
import { WORKBOOK_SOURCE_SCOPE } from '../../worker/core/workbook-source-registry.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2027-03-02T08:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const SMALL_DIRECTORY = 10
const LARGE_DIRECTORY = 810
const actor = authorityActor({ id: 'stf_slice_cost', role: 'owner' })
const config = Object.freeze({
  appEnv: 'staging', dataMode: 'fictional', activeDataKekVersion: 1,
  activeLookupKeyVersion: 1, activeWorkbookKekVersion: 1, activeWorkbookHmacVersion: 1,
})
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const directoryName = (index) => `Katalog${index} Osoba`
let keyring
let sourceKey
let serial = 0
const idFactory = () => `slicecost${++serial}`

const sealSource = async (recordId, field, value) => JSON.stringify(
  await encryptForScope(keyring, sourceKey, {
    expectedScope: WORKBOOK_SOURCE_SCOPE, recordId, field,
    plaintext: JSON.stringify(value),
  }),
)

const seedDirectory = async (from, to) => {
  for (let index = from; index < to; index += 1) {
    const id = `hcl_slicecost${String(index).padStart(5, '0')}`
    const built = await buildHistoricalIdentity(env.DB, keyring, {
      kind: 'person', id, dataKeyId: `key_seed_slicecost${index}`,
      name: directoryName(index), createdAt: NOW,
    })
    await env.DB.batch([
      built.keyStatement,
      env.DB.prepare(`INSERT INTO historical_clients
        (id,identity_envelope,status,active_client_id,version,created_at,updated_at)
        VALUES (?,?,'historical',NULL,1,?,?)`).bind(id, built.identityEnvelope, NOW, NOW),
      ...built.lookups.map((lookup) => env.DB.prepare(
        `INSERT INTO historical_client_lookup_aliases
         (historical_client_id,domain,hmac_version,lookup_digest,created_at)
         VALUES (?,?,?,?,?)`,
      ).bind(id, lookup.domain, lookup.version, lookup.digest, NOW)),
    ])
  }
}

// A committed legacy import whose income rows name identities already in the
// directory, so every measured slice does exactly the same per-row work and only
// the size of the directory around it differs.
const seedImport = async (suffix, rows, nameFor) => {
  const importId = `wbi_slicecost_${suffix}`
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,materializer_version,
       object_key,content_nonce_b64,workbook_kek_version,metadata_hmac_version,
       metadata_signature,created_by_staff_id,created_at)
      VALUES (?,'centre_1','staging',?,4096,2,2,?,'DDDDDDDDDDDDDDDD',1,1,?,?,?)`).bind(
      `wba_slicecost_${suffix}`, suffix.repeat(64).slice(0, 64),
      `workbook-objects/wbo_slicecost_${suffix}`.padEnd(48, '0'), 'H'.repeat(43), actor.id, NOW,
    ),
    env.DB.prepare(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,'complete',?,0,?,?,2,?,?,?)`).bind(
      importId, `wba_slicecost_${suffix}`, suffix.repeat(43).slice(0, 43), rows,
      `slicecost_${suffix}`, actor.id, NOW, NOW, NOW,
    ),
    env.DB.prepare(`INSERT INTO workbook_import_plans
      (import_id,workbook_kind,plan_version,plan_envelope,created_at)
      VALUES (?,'legacy',1,?,?)`).bind(
      importId, await sealSource(importId, 'materialization_plan', {
        schema: 'workbook_import_plan.v1',
      }), NOW,
    ),
    env.DB.prepare(`INSERT INTO workbook_materialization_jobs
      (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
       summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,'complete','complete',?,?,?,'{}','{}',?,2,?,?,?)`).bind(
      `wbj_slicecost_${suffix}`, importId, rows, rows, rows, actor.id, NOW, NOW, NOW,
    ),
    env.DB.prepare(`INSERT INTO finance_import_batches
      (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
       created_by_staff_id,version,created_at,updated_at,committed_at)
      VALUES (?,?,'{}',1,?,?,'committed',?,1,?,?,?)`).bind(
      `fib_slicecost_${suffix}`, suffix.repeat(64).slice(0, 63).padEnd(64, '0'),
      rows, rows, actor.id, NOW, NOW, NOW,
    ),
  ])
  const specialistDigest = await digestWorkbookSourceValue({
    keyring, config, centreId: 'centre_1', sourceValueKind: 'blank', sourceValue: '',
  })
  await env.DB.batch([env.DB.prepare(`INSERT INTO workbook_resolutions
    (id,import_id,source_record_id,kind,resolution_code,specialist_id,
     source_value_kind,source_value_digest,source_value_hmac_version,
     source_value_envelope,resolved_by_staff_id,created_at)
    VALUES (?,?,NULL,'specialist_mapping','blank_assigned_to_julia','sp_slice_cost',
      'blank',?,1,?,?,?)`).bind(
    `wbr_slicecost_${suffix}`, importId, specialistDigest.digest,
    await sealSource(`wbr_slicecost_${suffix}`, 'source_value', {
      schema: 'workbook_specialist_source.v1', sourceValue: '',
    }), actor.id, NOW,
  )])
  for (let index = 0; index < rows; index += 1) {
    const tag = `${suffix}${String(index).padStart(4, '0')}`
    const sourceRecordId = `wbs_slicecost_${tag}`
    const rowNumber = index + 2
    const normalized = Object.freeze({
      sourceKey: `workbook:v1:0:${rowNumber}:0`, sheet: 'Styczeń 2025', rowNumber,
      recordType: 'income', accountingMonth: '2025-01',
      occurredOn: '2025-01-15', periodPrecision: 'day', periodMonth: '2025-01',
      amountGrosze: 18000, counterparty: nameFor(index),
      sourceLabel: 'Zajęcia psychologiczne', paymentMethod: 'cash',
      settlementStatus: 'paid', invoiceStatus: 'not_required', invoiceNote: '',
      specialistName: null, lessonCount: null, warningCodes: [],
    })
    const payload = Object.freeze({
      schema: 'workbook_source_payload.v1', normalized, raw: Object.freeze({ Cena: 180 }),
    })
    const sourceDigest = await digestWorkbookSourcePayload({
      keyring, config, centreId: 'centre_1', sourceKey: normalized.sourceKey, payload,
    })
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_source_records
        (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
         disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
         payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
         record_digest,record_digest_hmac_version,specialist_source_digest,
         specialist_source_hmac_version,warning_codes_json,source_payload_version,
         source_payload_envelope,created_at)
        VALUES (?,?,?,0,'Styczeń 2025',?,0,'income','accepted','2025-01','2025-01-15',
          'day','2025-01',18000,'cash','paid','not_required',18000,?,1,?,1,'[]',1,?,?)`).bind(
        sourceRecordId, importId, normalized.sourceKey, rowNumber, sourceDigest.digest,
        specialistDigest.digest,
        await sealSource(sourceRecordId, 'source_payload', payload), NOW,
      ),
      env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
         specialist_id,appointment_id,counterparty_lookup,details_envelope,
         source_row_envelope,version,created_by_staff_id,created_at,updated_at)
        VALUES (?,?,?,'income','income','2025-01','2025-01-15',18000,18000,'cash','paid',
          'not_required','sp_slice_cost',NULL,NULL,'{}','{}',1,?,?,?)`).bind(
        `fin_slicecost_${tag}`, `fib_slicecost_${suffix}`, `source-slicecost-${tag}`,
        actor.id, NOW, NOW,
      ),
      env.DB.prepare(`INSERT INTO finance_source_links
        (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
        VALUES (?,?,?,'materialized',?,?)`).bind(
        `fsl_slicecost_${tag}`, sourceRecordId, `fin_slicecost_${tag}`, actor.id, NOW,
      ),
    ])
  }
  return importId
}

const sliceRowsRead = async (importId, expectedVersion) => {
  const before = await env.DB.prepare(
    `SELECT count(*) AS count FROM historical_service_occurrences`,
  ).first()
  let rowsRead = 0
  const track = (result) => {
    for (const entry of Array.isArray(result) ? result : [result]) {
      rowsRead += entry?.meta?.rows_read ?? 0
    }
    return result
  }
  const inner = new WeakMap()
  const wrap = (statement) => {
    const wrapper = {
      bind: (...values) => wrap(statement.bind(...values)),
      run: (...args) => statement.run(...args).then(track),
      first: (...args) => statement.first(...args).then((row) => row),
      all: (...args) => statement.all(...args).then(track),
      raw: (...args) => statement.raw(...args),
    }
    inner.set(wrapper, statement)
    return wrapper
  }
  const db = {
    prepare: (...args) => wrap(env.DB.prepare(...args)),
    batch: (statements) => env.DB.batch(
      statements.map((statement) => inner.get(statement)),
    ).then(track),
  }
  const result = await continueHistoricalProjection({
    db, actor, keyring, config, centreId: 'centre_1', importId,
    expectedVersion, idempotencyKey: `slicecost-${importId}-${expectedVersion}`,
    idFactory, nowMs: NOW_MS,
  })
  const after = await env.DB.prepare(
    `SELECT count(*) AS count FROM historical_service_occurrences`,
  ).first()
  return { rowsRead, projected: after.count - before.count, result }
}

describe('koszt partii projekcji nie zależy od rozmiaru katalogu', () => {
  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await applyFinanceStageC()
    await applySpecialistProfilesStageD()
    await applyWorkbookRegistryStageE()
    keyring = await createKeyring({
      BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V1: key(2),
      BWM_WORKBOOK_KEK_V1: key(3), BWM_WORKBOOK_HMAC_V1: key(4),
    }, config)
    await env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,'{}','{}','owner','active',?,NULL,1,?,NULL,?,?)`).bind(
      actor.id, 'slice_cost_lookup', 'slice-cost-subject', NOW, NOW, NOW,
    ).run()
    await env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
       archived_at,created_at,updated_at)
      VALUES ('sp_slice_cost',NULL,'{}',18000,'active',1,NULL,?,?)`).bind(NOW, NOW).run()
    sourceKey = await getOrCreateDataKey(env.DB, keyring, WORKBOOK_SOURCE_SCOPE, {
      id: 'key_slicecost_source', createdAt: NOW,
    })
  })

  it('czyta tyle samo wierszy przy katalogu 10 i przy 810', async () => {
    const rows = HISTORICAL_PROJECTION_SLICE_SIZE
    await seedDirectory(0, SMALL_DIRECTORY)
    const small = await seedImport('a', rows, (index) => directoryName(index))
    await sliceRowsRead(small, 0)
    const smallSlice = await sliceRowsRead(small, 1)
    expect(smallSlice.projected).toBe(rows)

    await seedDirectory(SMALL_DIRECTORY, LARGE_DIRECTORY)
    const large = await seedImport('b', rows, (index) => directoryName(SMALL_DIRECTORY + index))
    await sliceRowsRead(large, 0)
    const largeSlice = await sliceRowsRead(large, 1)
    expect(largeSlice.projected).toBe(rows)

    // Eighty times the directory must not cost meaningfully more to read. The
    // allowance covers index descents, not a scan of the directory itself.
    expect(largeSlice.rowsRead).toBeLessThan(smallSlice.rowsRead + 50)
    expect(largeSlice.rowsRead).toBeLessThan(LARGE_DIRECTORY / 2)
  }, 600_000)

  it('tworzy jedną tożsamość, gdy ta sama nowa nazwa wraca w jednej partii', async () => {
    const rows = HISTORICAL_PROJECTION_SLICE_SIZE
    const importId = await seedImport('c', rows, () => 'Powtorzona Nowa Osoba')
    await sliceRowsRead(importId, 0)
    const slice = await sliceRowsRead(importId, 1)
    expect(slice.projected).toBe(rows)
    const subjects = await env.DB.prepare(
      `SELECT count(DISTINCT occurrence.historical_client_id) AS count
       FROM historical_service_occurrences AS occurrence
       JOIN workbook_source_records AS source ON source.id=occurrence.source_record_id
       WHERE source.import_id=?`,
    ).bind(importId).first()
    expect(subjects.count).toBe(1)
  }, 600_000)
})
