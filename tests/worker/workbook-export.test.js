import { env } from 'cloudflare:workers'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportWorkbook } from '../../worker/core/workbooks.js'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import {
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import {
  digestWorkbookSourceValue,
  storeWorkbookArtifact,
} from '../../worker/security/workbook-artifacts.js'
import { readPanelWorkbook } from '../../src/workbook-ooxml.js'
import { parseWorkbookFile } from '../../src/workbook-import.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = Date.parse('2027-01-15T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const OWNER_ID = 'stf_workbook_export_owner'
const SPECIALIST_ID = 'sp_workbook_export_julia'
const ROTATED_SPECIALIST_ID = 'sp_workbook_export_anna_rotated'
const actor = Object.freeze({ id: OWNER_ID, role: 'owner', specialistId: null, version: 1 })
const config = Object.freeze({
  appEnv: 'staging', dataMode: 'fictional', activeDataKekVersion: 1,
  activeLookupKeyVersion: 1, activeWorkbookKekVersion: 1, activeWorkbookHmacVersion: 1,
})
const FINANCE_SCOPE = Object.freeze({ type: 'centre_finance', id: 'centre_1', purpose: 'ledger' })
const IDENTITY_SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const createdObjects = []

const workbookBytes = () => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'),
  '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
  'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Wrzesień" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="1"/></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'),
  'xl/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0"/></cellStyles></styleSheet>'),
  'xl/sharedStrings.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>'),
  'xl/calcChain.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B4" i="1"/></calcChain>'),
  'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:H6"/><sheetData>
<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Usługa</t></is></c><c r="B1" s="1" t="inlineStr"><is><t>Cena</t></is></c><c r="C1" s="1" t="inlineStr"><is><t>Klient</t></is></c><c r="D1" s="1" t="inlineStr"><is><t>Data zakupu</t></is></c><c r="E1" s="1" t="inlineStr"><is><t>Sposób płatności</t></is></c><c r="F1" s="1" t="inlineStr"><is><t>Status</t></is></c><c r="G1" s="1" t="inlineStr"><is><t>Faktura</t></is></c><c r="H1" s="1" t="inlineStr"><is><t>Psycholog</t></is></c></row>
<row r="2"><c r="A2" s="1" t="inlineStr"><is><t>Fikcyjna konsultacja</t></is></c><c r="B2" s="1"><v>180</v></c><c r="C2" s="1" t="inlineStr"><is><t>Osoba A</t></is></c><c r="D2" s="1" t="d"><v>2025-09-02</v></c><c r="E2" s="1" t="inlineStr"><is><t>Gotówka</t></is></c><c r="F2" s="1" t="inlineStr"><is><t>Opłacona</t></is></c><c r="G2" s="1"/><c r="H2" s="1"/></row>
<row r="3"><c r="A3" s="1" t="inlineStr"><is><t>Podpisane unieważnienie</t></is></c><c r="B3" s="1"><v>90</v></c><c r="C3" s="1" t="inlineStr"><is><t>Osoba B</t></is></c><c r="D3" s="1" t="d"><v>2025-09-03</v></c></row>
<row r="4"><c r="A4" s="1" t="inlineStr"><is><t>Suma dowodowa</t></is></c><c r="B4" s="1"><f>SUM(B2:B3)</f><v>270</v></c></row>
<row r="5"><c r="A5" s="1" t="inlineStr"><is><t>Wiersz kwarantanny</t></is></c><c r="B5" s="1"><v>75</v></c><c r="C5" s="1" t="inlineStr"><is><t>Osoba C</t></is></c></row>
<row r="6"><c r="A6" s="1" t="inlineStr"><is><t>Stały przychód</t></is></c><c r="B6" s="1"><v>130</v></c></row>
</sheetData></worksheet>`),
})

const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map((value) => value.toString(16).padStart(2, '0')).join('')

const insertArtifact = async ({ bytes, id, objectKey, format, sourceKind, importId, createdAt }) => {
  const fingerprint = await sha256(bytes)
  const descriptor = await storeWorkbookArtifact({
    bucket: env.ARCHIVE, keyring, config, centreId: 'centre_1', objectKey, bytes,
    fingerprint, parserVersion: 2, materializerVersion: 2,
    nonceFactory: () => new Uint8Array(12).fill(format === 'legacy' ? 21 : 22),
  })
  createdObjects.push(objectKey)
  await env.DB.prepare(`INSERT INTO workbook_artifacts
    (id,centre_id,environment,fingerprint,byte_size,parser_version,materializer_version,
     object_key,content_nonce_b64,workbook_kek_version,metadata_hmac_version,
     metadata_signature,created_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, 'centre_1', descriptor.environment, descriptor.fingerprint, descriptor.byteSize,
    descriptor.parserVersion, descriptor.materializerVersion, descriptor.objectKey,
    descriptor.contentNonce, descriptor.workbookKekVersion, descriptor.metadataHmacVersion,
    descriptor.metadataSignature, OWNER_ID, createdAt,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_templates
    (id,artifact_id,format,source_kind,created_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?)`).bind(
    `wbt_${id.slice(4)}`, id, format, sourceKind, OWNER_ID, createdAt,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_imports
    (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
     correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES (?,?,?,'complete',?,?,?,?,1,?,?,?)`).bind(
    importId, id, format === 'legacy' ? 'L'.repeat(43) : 'P'.repeat(43),
    format === 'legacy' ? 2 : 0, format === 'legacy' ? 1 : 0,
    `corr_${importId}`, OWNER_ID,
    createdAt, createdAt, createdAt,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_materialization_jobs
    (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
     summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES (?,?,'complete','complete',0,0,0,'{}','{}',?,1,?,?,?)`).bind(
    `wbj_${id.slice(4)}`, importId, OWNER_ID, createdAt, createdAt, createdAt,
  ).run()
  return descriptor
}

let keyring
let financeKey
let identityKey

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,'active',?,?,1,?,NULL,?,?)`).bind(
    OWNER_ID, 'workbook_export_owner_lookup', '{}', '{}', 'owner',
    'workbook-export-owner-subject', null, NOW, NOW, NOW,
  ).run()
  keyring = await createKeyring({
    BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V1: key(2),
    BWM_WORKBOOK_KEK_V1: key(9), BWM_WORKBOOK_HMAC_V1: key(10),
  }, config)
  financeKey = await getOrCreateDataKey(env.DB, keyring, FINANCE_SCOPE, {
    id: 'key_workbook_export_finance', createdAt: NOW,
  })
  identityKey = await getOrCreateDataKey(env.DB, keyring, IDENTITY_SCOPE, {
    id: 'key_workbook_export_identity', createdAt: NOW,
  })
  const rotatedIdentityKey = await getOrCreateDataKey(env.DB, keyring, IDENTITY_SCOPE, {
    id: 'key_workbook_export_identity_v2', dekVersion: 2,
    createdAt: '2027-01-15T10:00:00.001Z',
  })
  const displayNameEnvelope = JSON.stringify(await encryptForScope(keyring, identityKey, {
    expectedScope: IDENTITY_SCOPE, recordId: SPECIALIST_ID, field: 'display_name',
    plaintext: 'Julia Wolanin',
  }))
  await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
     archived_at,created_at,updated_at) VALUES (?,NULL,?,18000,'active',1,NULL,?,?)`).bind(
    SPECIALIST_ID, displayNameEnvelope, NOW, NOW,
  ).run()
  const rotatedDisplayNameEnvelope = JSON.stringify(await encryptForScope(
    keyring, rotatedIdentityKey, {
      expectedScope: IDENTITY_SCOPE, recordId: ROTATED_SPECIALIST_ID,
      field: 'display_name', plaintext: 'Anna Janowska',
    },
  ))
  await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
     archived_at,created_at,updated_at) VALUES (?,NULL,?,18000,'active',1,NULL,?,?)`).bind(
    ROTATED_SPECIALIST_ID, rotatedDisplayNameEnvelope, NOW, NOW,
  ).run()
})

afterAll(async () => {
  await Promise.all(createdObjects.map((objectKey) => env.ARCHIVE.delete(objectKey)))
})

const sealFinance = async (recordId, field, value) => JSON.stringify(await encryptForScope(
  keyring, financeKey, {
    expectedScope: FINANCE_SCOPE, recordId, field, plaintext: JSON.stringify(value),
  },
))

describe('legacy workbook export', () => {
  it('patches linked canonical facts and only signed Panel voids while retaining evidence', async () => {
    const legacy = workbookBytes()
    await insertArtifact({
      bytes: legacy, id: 'wba_export_legacy',
      objectKey: 'workbook-objects/wbo_export_legacy_fixture_000001',
      format: 'legacy', sourceKind: 'approved_import', importId: 'wbi_export_legacy',
      createdAt: NOW,
    })
    await insertArtifact({
      bytes: strToU8('newer encrypted panel marker'), id: 'wba_export_panel',
      objectKey: 'workbook-objects/wbo_export_panel_fixture_000002',
      format: 'panel-v2', sourceKind: 'panel_round_trip', importId: 'wbi_export_panel',
      createdAt: '2027-01-15T10:01:00.000Z',
    })
    await env.DB.prepare(`INSERT INTO workbook_import_plans
      (import_id,workbook_kind,plan_version,plan_envelope,created_at)
      VALUES ('wbi_export_panel','panel-v2',1,'{}',?)`).bind(
      '2027-01-15T10:01:00.000Z',
    ).run()
    const blank = await digestWorkbookSourceValue({
      keyring, config, centreId: 'centre_1', sourceValueKind: 'blank', sourceValue: '',
    })
    for (const [id, rowNumber, disposition] of [
      ['wbs_export_edit', 2, 'accepted'],
      ['wbs_export_void', 3, 'accepted'],
      ['wbs_export_quarantine', 5, 'quarantined'],
    ]) await env.DB.prepare(`INSERT INTO workbook_source_records
      (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
       record_type,disposition,accounting_month,occurred_on,period_precision,
       period_month,amount_grosze,
       payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
       record_digest,record_digest_hmac_version,specialist_source_digest,
       specialist_source_hmac_version,warning_codes_json,source_payload_version,
       source_payload_envelope,created_at)
      VALUES (?,?,'workbook:v1:0:' || ? || ':0',0,'Wrzesień',?,0,'income',?,
              '2025-09',?,CASE WHEN ? IS NULL THEN 'unknown' ELSE 'day' END,
              CASE WHEN ? IS NULL THEN NULL ELSE '2025-09' END,
              ?,'cash','paid','not_required',?,
              'R' || substr(?,2),1,?,1,'[]',1,'{}',?)`).bind(
      id, 'wbi_export_legacy', rowNumber, rowNumber, disposition,
      rowNumber === 5 ? null : `2025-09-0${rowNumber}`,
      rowNumber === 5 ? null : `2025-09-0${rowNumber}`,
      rowNumber === 5 ? null : `2025-09-0${rowNumber}`,
      rowNumber === 2 ? 18_000 : rowNumber === 3 ? 9_000 : 7_500,
      rowNumber === 2 ? 18_000 : rowNumber === 3 ? 9_000 : 7_500,
      'R'.repeat(43), blank.digest, NOW,
    ).run()
    await env.DB.prepare(`INSERT INTO workbook_quarantine_records
      (id,source_record_id,primary_reason,reason_codes_json,created_at)
      VALUES ('wbq_export_quarantine','wbs_export_quarantine','SERVICE_DATE_MISSING',
              '["SERVICE_DATE_MISSING"]',?)`).bind(NOW).run()
    await env.DB.prepare(`INSERT INTO workbook_resolutions
      (id,import_id,source_record_id,kind,resolution_code,specialist_id,
       source_value_kind,source_value_digest,source_value_hmac_version,
       source_value_envelope,resolved_by_staff_id,created_at)
      VALUES ('wbr_export_blank','wbi_export_legacy',NULL,'specialist_mapping',
              'blank_assigned_to_julia',?,'blank',?,1,'{}',?,?)`).bind(
      SPECIALIST_ID, blank.digest, OWNER_ID, NOW,
    ).run()
    await env.DB.prepare(`INSERT INTO workbook_source_records
      (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
       record_type,disposition,accounting_month,occurred_on,period_precision,
       period_month,amount_grosze,
       payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
       record_digest,record_digest_hmac_version,specialist_source_digest,
       specialist_source_hmac_version,warning_codes_json,source_payload_version,
       source_payload_envelope,created_at)
      VALUES ('wbs_export_block','wbi_export_legacy','workbook:v1:0:6:1',0,'Wrzesień',
              6,1,'income','accepted','2025-09',NULL,'month','2025-09',13000,
              'cash','paid','not_required',13000,?,1,?,1,'[]',1,'{}',?)`).bind(
      'B'.repeat(43), blank.digest, NOW,
    ).run()
    await env.DB.prepare(`INSERT INTO finance_import_batches
      (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
       created_by_staff_id,version,created_at,updated_at,committed_at)
      VALUES ('fib_export_legacy',?,'{}',1,6,6,'committed',?,1,?,?,?)`).bind(
      'f'.repeat(64), OWNER_ID, NOW, NOW, NOW,
    ).run()
    const entries = [
      ['fin_export_edit', 'edit', 2, 20_000, '2025-10', SPECIALIST_ID],
      ['fin_export_void', 'void', 3, 9_000, '2025-09', SPECIALIST_ID],
      ['fin_export_formula', 'formula', 4, 27_000, '2025-09', null],
      ['fin_export_quarantine', 'quarantine', 5, 7_500, '2025-09', null],
      ['fin_export_unlinked', 'unlinked', 6, 12_000, '2025-11', SPECIALIST_ID],
      ['fin_export_unlinked_v2', 'unlinked-v2', 7, 13_000, '2025-12', ROTATED_SPECIALIST_ID],
      ['fin_export_block', 'block', 6, 14_000, '2025-12', ROTATED_SPECIALIST_ID],
    ]
    for (const [id, source, rowNumber, amount, month, specialistId] of entries) {
      await env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,
         invoice_status,specialist_id,appointment_id,counterparty_lookup,
         details_envelope,source_row_envelope,version,created_by_staff_id,
         created_at,updated_at)
        VALUES (?,'fib_export_legacy',?,'income','income',?,?,?,?,'transfer','partial',
                'action_required',?,NULL,NULL,?,?,2,?,?,?)`).bind(
        id, `safe-export-${source}`, month,
        rowNumber === 5 || id === 'fin_export_block' ? null : `2025-09-0${rowNumber}`,
        amount, id === 'fin_export_edit' ? 9_000 : amount - 100, specialistId,
        await sealFinance(id, 'details', {
          schema: 'finance_entry_details.v1', counterparty: '', sourceLabel: '',
          invoiceNote: '', lessonCount: null,
        }),
        await sealFinance(id, 'source_row', {
          schema: 'finance_entry_source.v1',
          source: { batchId: 'fib_export_legacy', sourceKey: `workbook:v1:0:${rowNumber}:0`,
            sheet: 'Wrzesień', rowNumber, raw: {} },
        }),
        OWNER_ID, NOW, NOW,
      ).run()
    }
    for (const [linkId, sourceId, entryId] of [
      ['fsl_export_edit', 'wbs_export_edit', 'fin_export_edit'],
      ['fsl_export_void', 'wbs_export_void', 'fin_export_void'],
      ['fsl_export_block', 'wbs_export_block', 'fin_export_block'],
    ]) await env.DB.prepare(`INSERT INTO finance_source_links
      (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
      VALUES (?,?,?,'reconciled',?,?)`).bind(linkId, sourceId, entryId, OWNER_ID, NOW).run()
    for (const [id, entryId, sourceId, reason] of [
      ['fev_export_signed', 'fin_export_void', null, 'panel_signed_void'],
      ['fev_export_formula', 'fin_export_formula', null, 'formula_cache'],
      ['fev_export_quarantine', 'fin_export_quarantine', 'wbs_export_quarantine', 'quarantined'],
    ]) await env.DB.prepare(`INSERT INTO finance_entry_voids
      (id,finance_entry_id,workbook_import_id,workbook_source_record_id,reason_code,
       voided_by_staff_id,created_at) VALUES (?,?,?,?,?,?,?)`).bind(
      id, entryId, reason === 'panel_signed_void' ? 'wbi_export_panel' : 'wbi_export_legacy',
      sourceId, reason, OWNER_ID, NOW,
    ).run()

    const beforeObjects = (await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length
    const snapshotBatchSizes = []
    const snapshotDb = {
      prepare: (...args) => env.DB.prepare(...args),
      batch: async (statements) => {
        snapshotBatchSizes.push(statements.length)
        return env.DB.batch(statements)
      },
    }
    const queryBudget = createD1QueryBudget(snapshotDb, {
      totalLimit: 50, recoveryReserve: 8,
    })
    const exported = await exportWorkbook({
      db: queryBudget.work, bucket: env.ARCHIVE, actor, keyring, config,
      centreId: 'centre_1', nowMs: NOW_MS + 120_000, format: 'legacy',
    })
    const files = unzipSync(exported.bytes)
    const worksheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    const allText = Object.values(files).map((bytes) => strFromU8(bytes)).join('\n')

    expect(exported.filename).toBe('bear-with-me-legacy-2027-01-15.xlsx')
    expect((await readPanelWorkbook(exported.bytes)).kind).toBe('legacy')
    expect(worksheet).toMatch(/<c r="B2" s="1"><v>200<\/v><\/c>/)
    expect(worksheet).toMatch(/<c r="B6" s="1"><v>140<\/v><\/c>/)
    expect(worksheet).toMatch(/<c r="I2" s="1" t="s"><v>\d+<\/v><\/c>/)
    expect(allText).toContain('2025-10')
    expect(allText).toContain('Julia Wolanin')
    expect(allText).toContain('Przelew')
    expect(allText).toContain('Częściowo opłacona')
    expect(allText).toContain('Do wystawienia')
    expect(allText).toContain('Zapłacono (gr)')
    expect(allText).toContain('fin_export_unlinked')
    expect(allText).toContain('fin_export_unlinked_v2')
    expect(allText).toContain('Anna Janowska')
    expect(allText).toContain('fin_export_block')
    expect(allText).toContain('Zmiany rekordu ze źródła: miesiąc 2025-12; płatność przelew; status częściowo opłacona; faktura do wystawienia')
    expect(worksheet).toMatch(/<row r="3"><\/row>/)
    expect(worksheet).toMatch(/<c r="B4" s="1"><f>SUM\(B2:B3\)<\/f><\/c>/)
    expect(worksheet).toContain('Wiersz kwarantanny')
    expect(allText).not.toContain('Panel — Meta')
    const reparsed = await parseWorkbookFile(exported.bytes.buffer.slice(
      exported.bytes.byteOffset,
      exported.bytes.byteOffset + exported.bytes.byteLength,
    ), { filename: exported.filename })
    expect(reparsed.rows.find(({ sourceKey }) => sourceKey === 'workbook:v1:0:2:0'))
      .toMatchObject({ accountingMonth: '2025-10', amountGrosze: 20_000 })
    expect((await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length)
      .toBe(beforeObjects)
    expect(snapshotBatchSizes).toEqual([4])
    expect(queryBudget.usage()).toMatchObject({ used: 7, workRemaining: 35 })
  })

  it('refuses a snapshot while any workbook materialization can still mutate the ledger', async () => {
    const bytes = strToU8('pending fictional workbook bytes')
    const objectKey = 'workbook-objects/wbo_export_pending_fixture_000003'
    const descriptor = await storeWorkbookArtifact({
      bucket: env.ARCHIVE, keyring, config, centreId: 'centre_1', objectKey, bytes,
      fingerprint: await sha256(bytes), parserVersion: 2, materializerVersion: 2,
      nonceFactory: () => new Uint8Array(12).fill(23),
    })
    createdObjects.push(objectKey)
    await env.DB.prepare(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,materializer_version,
       object_key,content_nonce_b64,workbook_kek_version,metadata_hmac_version,
       metadata_signature,created_by_staff_id,created_at)
      VALUES ('wba_export_pending','centre_1',?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      descriptor.environment, descriptor.fingerprint, descriptor.byteSize,
      descriptor.parserVersion, descriptor.materializerVersion, descriptor.objectKey,
      descriptor.contentNonce, descriptor.workbookKekVersion, descriptor.metadataHmacVersion,
      descriptor.metadataSignature, OWNER_ID, '2027-01-15T10:03:00.000Z',
    ).run()
    await env.DB.prepare(`INSERT INTO workbook_templates
      (id,artifact_id,format,source_kind,created_by_staff_id,created_at)
      VALUES ('wbt_export_pending','wba_export_pending','legacy','approved_import',?,?)`).bind(
      OWNER_ID, '2027-01-15T10:03:00.000Z',
    ).run()
    await env.DB.prepare(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES ('wbi_export_pending','wba_export_pending',?,'ready',0,0,?,?,1,?,?,NULL)`).bind(
      'Q'.repeat(43), 'corr_wbi_export_pending', OWNER_ID,
      '2027-01-15T10:03:00.000Z', '2027-01-15T10:03:00.000Z',
    ).run()
    await env.DB.prepare(`INSERT INTO workbook_materialization_jobs
      (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
       summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES ('wbj_export_pending','wbi_export_pending','apply_finance','ready',0,0,0,
              '{}',NULL,?,1,?,?,NULL)`).bind(
      OWNER_ID, '2027-01-15T10:03:00.000Z', '2027-01-15T10:03:00.000Z',
    ).run()

    let artifactReads = 0
    const unreadBucket = {
      async get() { artifactReads += 1; throw new Error('R2_READ_TRAP') },
    }
    await expect(exportWorkbook({
      db: env.DB, bucket: unreadBucket, actor, keyring, config,
      centreId: 'centre_1', nowMs: NOW_MS + 240_000, format: 'legacy',
    })).rejects.toThrow(/^WORKBOOK_EXPORT_CONFLICT$/)
    expect(artifactReads).toBe(0)

    await env.DB.batch([
      env.DB.prepare(`UPDATE workbook_materialization_jobs
        SET status='failed',version=2,updated_at=? WHERE id='wbj_export_pending'`).bind(
        '2027-01-15T10:04:00.000Z',
      ),
      env.DB.prepare(`UPDATE workbook_imports
        SET status='failed',version=2,updated_at=? WHERE id='wbi_export_pending'`).bind(
        '2027-01-15T10:04:00.000Z',
      ),
    ])
  })

  it('fails closed before R2 on snapshot transaction failure or a 5,001-row panel result', async () => {
    const statement = Object.freeze({ bind() { return this } })
    let artifactReads = 0
    const unreadBucket = {
      async get() { artifactReads += 1; throw new Error('R2_READ_TRAP') },
    }
    await expect(exportWorkbook({
      db: {
        prepare: () => statement,
        batch: async () => { throw new Error('D1_SNAPSHOT_TRAP') },
      },
      bucket: unreadBucket, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 300_000, format: 'panel-v2',
    })).rejects.toThrow(/^INTERNAL_ERROR$/)

    await expect(exportWorkbook({
      db: {
        prepare: () => statement,
        batch: async () => [{
          results: [{ nonterminal: 0, object_key: 'opaque-workbook-object' }],
        }, {
          results: Array.from({ length: 5_001 }, (_, index) => ({ id: `fin_${index}` })),
        }],
      },
      bucket: unreadBucket, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 300_000, format: 'panel-v2',
    })).rejects.toThrow(/^WORKBOOK_EXPORT_LIMIT$/)
    expect(artifactReads).toBe(0)
  })
})
