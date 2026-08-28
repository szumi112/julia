import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ACTIVITY_PROJECTION_SLICE_SIZE,
  activityProjectionSourceReconciliation,
  continueActivityProjection,
  getActivityProjection,
  loadActivityProjectionCursorSlice,
  materializeActivitySlice,
} from '../../worker/core/activity-materializer.js'
import {
  WORKBOOK_SOURCE_SCOPE,
} from '../../worker/core/workbook-source-registry.js'
import { encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  createD1QueryBudget,
  usageForD1QueryBudgetViews,
} from '../../worker/db/query-budget.js'
import {
  digestWorkbookSourcePayload,
  digestWorkbookSourceValue,
} from '../../worker/security/workbook-artifacts.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = Date.parse('2027-03-03T08:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const IMPORT_ID = 'wbi_activity_materializer'
const actor = Object.freeze({
  id: 'stf_activity_materializer', role: 'owner', specialistId: null, version: 1,
})
const config = Object.freeze({
  appEnv: 'staging', dataMode: 'fictional', activeDataKekVersion: 1,
  activeLookupKeyVersion: 1, activeWorkbookKekVersion: 1,
  activeWorkbookHmacVersion: 1,
})
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
let keyring
let sourceDataKey
let serial = 0
const idFactory = () => `materialized_${++serial}`

const sealSource = async (recordId, field, value) => JSON.stringify(
  await encryptForScope(keyring, sourceDataKey, {
    expectedScope: WORKBOOK_SOURCE_SCOPE, recordId, field,
    plaintext: JSON.stringify(value),
  }),
)

const addSource = async ({
  sourceRecordId, financeEntryId, sourceKey, rowNumber, recordType,
  accountingMonth, occurredOn, counterparty, sourceLabel, lessonCount, amountGrosze,
  financeSpecialistId = 'sp_activity_materializer',
  periodPrecisionOverride = null, periodMonthOverride = accountingMonth,
}) => {
  const periodPrecision = periodPrecisionOverride ?? (occurredOn === null ? 'month' : 'day')
  const normalized = Object.freeze({
    sourceKey, sheet: recordType === 'tus' ? 'Grupa TUS' : 'Angielski', rowNumber,
    recordType, accountingMonth, occurredOn, periodPrecision,
    periodMonth: periodMonthOverride, amountGrosze, counterparty, sourceLabel,
    paymentMethod: 'transfer', settlementStatus: 'paid', invoiceStatus: 'not_required',
    invoiceNote: '', specialistName: null, lessonCount, warningCodes: [],
  })
  const payload = Object.freeze({
    schema: 'workbook_source_payload.v1', normalized,
    raw: Object.freeze({ FikcyjnyWiersz: rowNumber }),
  })
  const digest = await digestWorkbookSourcePayload({
    keyring, config, centreId: 'centre_1', sourceKey, payload,
  })
  const specialistDigest = await digestWorkbookSourceValue({
    keyring, config, centreId: 'centre_1', sourceValueKind: 'blank', sourceValue: '',
  })
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workbook_source_records
      (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
       disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
       payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
       record_digest,record_digest_hmac_version,specialist_source_digest,
       specialist_source_hmac_version,warning_codes_json,source_payload_version,
       source_payload_envelope,created_at)
      VALUES (?,?,?,0,?,?,0,?,'accepted',?,?,?,?,?,'transfer','paid','not_required',
       ?,?,1,?,1,'[]',1,?,?)`).bind(
      sourceRecordId, IMPORT_ID, sourceKey, normalized.sheet, rowNumber, recordType,
      accountingMonth, occurredOn, periodPrecision, periodMonthOverride, amountGrosze,
      amountGrosze, digest.digest, specialistDigest.digest,
      await sealSource(sourceRecordId, 'source_payload', payload), NOW,
    ),
    env.DB.prepare(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
       specialist_id,appointment_id,counterparty_lookup,details_envelope,
       source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,'fib_activity_materializer',?,'income',?,?,?,?,?,'transfer','paid',
       'not_required',?,NULL,NULL,'{}','{}',1,?,?,?)`).bind(
      financeEntryId, `materialized:${sourceKey}`, recordType, accountingMonth,
      occurredOn, amountGrosze, amountGrosze, financeSpecialistId, actor.id, NOW, NOW,
    ),
  ])
  await env.DB.prepare(`INSERT INTO finance_source_links
    (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
    VALUES (?,?,?,'materialized',?,?)`).bind(
    `fsl_${sourceRecordId.slice(4)}`, sourceRecordId, financeEntryId, actor.id, NOW,
  ).run()
}

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
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,'{}','{}','owner','active','activity-materializer-subject',NULL,1,
       ?,NULL,?,?)`).bind(actor.id, 'activity_materializer_lookup', NOW, NOW, NOW),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
       archived_at,created_at,updated_at)
      VALUES ('sp_activity_materializer',NULL,'{}',18000,'active',1,NULL,?,?)`)
      .bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
       archived_at,created_at,updated_at)
      VALUES ('sp_activity_wrong',NULL,'{}',18000,'active',1,NULL,?,?)`)
      .bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,materializer_version,
       object_key,content_nonce_b64,workbook_kek_version,metadata_hmac_version,
       metadata_signature,created_by_staff_id,created_at)
      VALUES ('wba_activity_materializer','centre_1','staging',?,4096,2,2,
       'workbook-objects/wbo_activity_materializer_one','AAAAAAAAAAAAAAAA',1,1,?,?,?)`)
      .bind('a'.repeat(64), 'A'.repeat(43), actor.id, NOW),
  ])
  await env.DB.prepare(`INSERT INTO workbook_imports
    (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
     correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES (?,'wba_activity_materializer',?,'complete',190,0,
     'activity_materializer_correlation',?,2,?,?,?)`).bind(
    IMPORT_ID, 'B'.repeat(43), actor.id, NOW, NOW, NOW,
  ).run()
  sourceDataKey = await getOrCreateDataKey(env.DB, keyring, WORKBOOK_SOURCE_SCOPE, {
    id: 'key_activity_source_materializer', createdAt: NOW,
  })
  const specialistDigest = await digestWorkbookSourceValue({
    keyring, config, centreId: 'centre_1', sourceValueKind: 'blank', sourceValue: '',
  })
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workbook_import_plans
      (import_id,workbook_kind,plan_version,plan_envelope,created_at)
      VALUES (?,'legacy',1,?,?)`).bind(
      IMPORT_ID, await sealSource(IMPORT_ID, 'materialization_plan', {
        schema: 'workbook_import_plan.v1',
      }), NOW,
    ),
    env.DB.prepare(`INSERT INTO workbook_materialization_jobs
      (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
       summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES ('wbj_activity_materializer',?,'complete','complete',190,190,190,'{}','{}',
       ?,2,?,?,?)`).bind(IMPORT_ID, actor.id, NOW, NOW, NOW),
    env.DB.prepare(`INSERT INTO workbook_resolutions
      (id,import_id,source_record_id,kind,resolution_code,specialist_id,
       source_value_kind,source_value_digest,source_value_hmac_version,
       source_value_envelope,resolved_by_staff_id,created_at)
      VALUES ('wbr_activity_materializer',?,NULL,'specialist_mapping',
       'blank_assigned_to_julia','sp_activity_materializer','blank',?,1,?,?,?)`).bind(
      IMPORT_ID, specialistDigest.digest,
      await sealSource('wbr_activity_materializer', 'source_value', {
        schema: 'workbook_specialist_source.v1', sourceValue: '',
      }), actor.id, NOW,
    ),
    env.DB.prepare(`INSERT INTO finance_import_batches
      (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
       created_by_staff_id,version,created_at,updated_at,committed_at)
      VALUES ('fib_activity_materializer',?,'{}',1,190,190,'committed',?,1,?,?,?)`)
      .bind('c'.repeat(64), actor.id, NOW, NOW, NOW),
  ])
  await addSource({
    sourceRecordId: 'wbs_activity_tus_day', financeEntryId: 'fin_activity_tus_day',
    sourceKey: 'workbook:v1:0:2:0', rowNumber: 2, recordType: 'tus',
    accountingMonth: '2025-01', occurredOn: '2025-01-15',
    counterparty: 'Ola Fikcyjna', sourceLabel: 'Grupa TUS — Sowy',
    lessonCount: null, amountGrosze: 34000,
  })
  await addSource({
    sourceRecordId: 'wbs_activity_english_zero', financeEntryId: 'fin_activity_english_zero',
    sourceKey: 'workbook:v1:0:3:0', rowNumber: 3, recordType: 'english',
    accountingMonth: '2025-01', occurredOn: null,
    counterparty: 'Maja Fikcyjna', sourceLabel: 'Lekcje języka angielskiego',
    lessonCount: 0, amountGrosze: 0,
  })
  await addSource({
    sourceRecordId: 'wbs_activity_wrong_specialist',
    financeEntryId: 'fin_activity_wrong_specialist',
    sourceKey: 'workbook:v1:0:4:0', rowNumber: 4, recordType: 'english',
    accountingMonth: '2025-01', occurredOn: null,
    counterparty: 'Zosia Fikcyjna', sourceLabel: 'Lekcje języka angielskiego',
    lessonCount: 2, amountGrosze: 10000,
  })
  const appendBulk = async (recordType, index, periodPrecision, occurredOn) => {
    const rowNumber = index + 10
    const accountingMonth = `2025-${String((index % 12) + 1).padStart(2, '0')}`
    await addSource({
      sourceRecordId: `wbs_activity_bulk_${String(index).padStart(3, '0')}`,
      financeEntryId: `fin_activity_bulk_${String(index).padStart(3, '0')}`,
      sourceKey: `workbook:v1:1:${rowNumber}:0`, rowNumber, recordType,
      accountingMonth, occurredOn,
      counterparty: recordType === 'tus'
        ? 'Masowa Uczestniczka Fikcyjna' : 'Masowa Uczennica Fikcyjna',
      sourceLabel: recordType === 'tus'
        ? 'Grupa TUS — Masowa Fikcyjna' : 'Lekcje języka angielskiego',
      lessonCount: recordType === 'english' ? 0 : null,
      amountGrosze: recordType === 'english' ? 0 : 34000,
      periodPrecisionOverride: periodPrecision,
    })
  }
  await appendBulk('tus', 0, 'day', '2025-01-20')
  for (let index = 1; index < 24; index += 1) {
    await appendBulk('tus', index, 'month', null)
  }
  for (let index = 24; index < 187; index += 1) {
    await appendBulk('english', index, 'month', null)
  }
})

describe('activity materializer', () => {
  it('materializes authenticated TUS/English facts without classes, attendance, or payments', async () => {
    expect(ACTIVITY_PROJECTION_SLICE_SIZE).toBe(1)
    const common = {
      db: env.DB, recoveryDb: env.DB, keyring, config,
      centreId: 'centre_1', importId: IMPORT_ID, actor, nowMs: NOW_MS, idFactory,
    }
    const tus = await materializeActivitySlice({
      ...common, sourceRecordIds: ['wbs_activity_tus_day'],
    })
    const english = await materializeActivitySlice({
      ...common, sourceRecordIds: ['wbs_activity_english_zero'],
    })
    expect(tus).toMatchObject({ projectedRecords: 1, replayedRecords: 0 })
    expect(english).toMatchObject({ projectedRecords: 1, replayedRecords: 0 })
    const counts = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM activity_participants) AS participants,
      (SELECT count(*) FROM activity_groups) AS groups,
      (SELECT count(*) FROM activity_memberships) AS memberships,
      (SELECT count(*) FROM activity_charges) AS charges,
      (SELECT count(*) FROM activity_classes) AS classes,
      (SELECT count(*) FROM activity_attendance) AS attendance`).first()
    expect(counts).toEqual({
      participants: 2, groups: 1, memberships: 1, charges: 2,
      classes: 0, attendance: 0,
    })
    const englishCharge = await env.DB.prepare(`SELECT lesson_count,group_id,membership_id,
      responsible_specialist_id FROM activity_charges WHERE finance_entry_id=?`)
      .bind('fin_activity_english_zero').first()
    expect(englishCharge).toEqual({
      lesson_count: 0, group_id: null, membership_id: null,
      responsible_specialist_id: 'sp_activity_materializer',
    })
    const tusMembership = await env.DB.prepare(`SELECT membership_kind,period_precision,
      observed_on,observed_month,starts_on,ends_on FROM activity_memberships`).first()
    expect(tusMembership).toEqual({
      membership_kind: 'observation', period_precision: 'day',
      observed_on: '2025-01-15', observed_month: '2025-01',
      starts_on: null, ends_on: null,
    })
    const stored = await env.DB.prepare(`SELECT participant.identity_envelope,
      activity_group.label_envelope FROM activity_participants AS participant
      CROSS JOIN activity_groups AS activity_group LIMIT 1`).first()
    expect(JSON.stringify(stored)).not.toContain('Fikcyjna')
    expect(JSON.stringify(stored)).not.toContain('Sowy')
  })

  it('converges on replay and rejects finance specialist drift from the audited mapping', async () => {
    const common = {
      db: env.DB, recoveryDb: env.DB, keyring, config,
      centreId: 'centre_1', importId: IMPORT_ID, actor, nowMs: NOW_MS, idFactory,
    }
    await env.DB.prepare(`UPDATE finance_entries SET
      specialist_id='sp_activity_wrong',version=2,updated_at=?
      WHERE id='fin_activity_wrong_specialist'`).bind(NOW).run()
    await expect(materializeActivitySlice({
      ...common, sourceRecordIds: ['wbs_activity_wrong_specialist'],
    })).rejects.toThrow(/ACTIVITY_PROJECTION_AUTHORITY_MISMATCH/)
    await env.DB.prepare(`UPDATE finance_entries SET
      specialist_id='sp_activity_materializer',version=3,updated_at=?
      WHERE id='fin_activity_wrong_specialist'`).bind(NOW).run()
    const replay = await materializeActivitySlice({
      ...common, sourceRecordIds: ['wbs_activity_tus_day'],
    })
    expect(replay).toMatchObject({ projectedRecords: 0, replayedRecords: 1 })
    expect((await env.DB.prepare('SELECT count(*) AS count FROM activity_charges').first()).count)
      .toBe(2)
  })

  it('walks the full authoritative 25 TUS plus 165 English source cursor without truncation', async () => {
    expect(await activityProjectionSourceReconciliation({
      db: env.DB, importId: IMPORT_ID,
    })).toEqual({
      totalRecords: 190, tusRecords: 25, tusDayRecords: 2, tusMonthRecords: 23,
      englishRecords: 165, englishMonthRecords: 165, invalidPeriodRecords: 0,
    })
    const seen = []
    let afterSourceRecordId = null
    while (true) {
      const slice = await loadActivityProjectionCursorSlice({
        db: env.DB, importId: IMPORT_ID, afterSourceRecordId,
      })
      expect(slice.sourceRecordIds.length).toBeLessThanOrEqual(1)
      seen.push(...slice.sourceRecordIds)
      if (slice.done) break
      afterSourceRecordId = slice.afterSourceRecordId
    }
    expect(seen).toHaveLength(190)
    expect(new Set(seen).size).toBe(190)
  })

  it('durably advances the exact projection with CAS, encrypted replay, audit, and completion semantics', async () => {
    const input = (
      expectedVersion, idempotencyKey, db = env.DB, recoveryDb = env.DB,
      commandIdFactory = idFactory,
    ) => ({
      db, recoveryDb, actor, keyring, config, centreId: 'centre_1', importId: IMPORT_ID,
      expectedVersion, idempotencyKey, idFactory: commandIdFactory, nowMs: NOW_MS,
    })
    await expect(getActivityProjection({
      db: env.DB, actor, importId: IMPORT_ID,
    })).resolves.toEqual({ data: { job: null } })
    await expect(continueActivityProjection(input(
      1, 'activity-job-precreate-stale-0001',
    ))).rejects.toMatchObject({
      message: 'VERSION_CONFLICT', details: { currentVersion: 0 },
    })
    const creates = await Promise.all([
      continueActivityProjection(input(0, 'activity-job-create-0001')),
      continueActivityProjection(input(0, 'activity-job-create-0001')),
    ])
    expect(creates[0].body).toEqual(creates[1].body)
    expect(creates.map(({ status }) => status)).toEqual([201, 201])
    const [created] = creates
    expect(created).toMatchObject({ body: { data: { job: {
      status: 'ready', totalRecords: 190, processedRecords: 0,
      projectedRecords: 0, version: 1,
    } } } })
    await expect(getActivityProjection({
      db: env.DB, actor, importId: IMPORT_ID,
    })).resolves.toEqual({ data: { job: created.body.data.job } })
    await expect(continueActivityProjection(input(
      0, 'activity-job-create-0001',
    ))).resolves.toEqual({ status: 201, body: created.body })

    await env.DB.prepare(`INSERT INTO audit_events
      (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
       reason_envelope,correlation_id,metadata_json)
      VALUES ('aud_forced_collision',?,?,'fixture.event','fixture','fixture_one',
       'success',NULL,'fixture_correlation','{}')`).bind(NOW, actor.id).run()
    const atomicFactory = (prefix) => prefix === 'aud'
      ? 'forced_collision' : `atomic_${++serial}`
    const beforeAtomic = await env.DB.prepare(`SELECT
      (SELECT version FROM activity_projection_jobs WHERE import_id=?) AS version,
      (SELECT count(*) FROM activity_source_links
       WHERE source_record_id='wbs_activity_bulk_000') AS source_links`).bind(
      IMPORT_ID,
    ).first()
    await expect(continueActivityProjection(input(
      1, 'activity-job-atomic-0001', env.DB, env.DB, atomicFactory,
    ))).rejects.toThrow(/identity_collision/)
    expect(await env.DB.prepare(`SELECT
      (SELECT version FROM activity_projection_jobs WHERE import_id=?) AS version,
      (SELECT count(*) FROM activity_source_links
       WHERE source_record_id='wbs_activity_bulk_000') AS source_links`).bind(
      IMPORT_ID,
    ).first()).toEqual(beforeAtomic)

    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const first = await continueActivityProjection(input(
      1, 'activity-job-step-000001', budget.work, budget.recovery,
    ))
    expect(first.body.data.job).toMatchObject({
      status: 'running', processedRecords: 1, projectedRecords: 1, version: 2,
    })
    const firstUsage = usageForD1QueryBudgetViews(budget.work, budget.recovery)
    expect(firstUsage).toEqual({
      used: 34, remaining: 16, workRemaining: 8,
      totalLimit: 50, recoveryReserve: 8,
    })
    const replayBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    await expect(continueActivityProjection(input(
      1, 'activity-job-step-000001', replayBudget.work, replayBudget.recovery,
    ))).resolves.toEqual({ status: 200, body: first.body })
    expect(usageForD1QueryBudgetViews(
      replayBudget.work, replayBudget.recovery,
    )).toEqual({
      used: 3, remaining: 47, workRemaining: 39,
      totalLimit: 50, recoveryReserve: 8,
    })

    let arrivals = 0
    let release
    const barrier = new Promise((resolve) => { release = resolve })
    const racingDb = () => Object.freeze({
      prepare: (...args) => env.DB.prepare(...args),
      batch: async (statements) => {
        arrivals += 1
        if (arrivals === 2) release()
        await barrier
        return env.DB.batch(statements)
      },
    })
    const race = await Promise.allSettled([
      continueActivityProjection(input(
        2, 'activity-job-race-a-0001', racingDb(), env.DB,
      )),
      continueActivityProjection(input(
        2, 'activity-job-race-b-0001', racingDb(), env.DB,
      )),
    ])
    expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(race.find(({ status }) => status === 'rejected')?.reason)
      .toMatchObject({
        message: 'VERSION_CONFLICT', details: { currentVersion: 3 },
      })

    let projection = (await getActivityProjection({
      db: env.DB, actor, importId: IMPORT_ID,
    })).data.job
    while (projection.status !== 'complete') {
      const result = await continueActivityProjection(input(
        projection.version,
        `activity-job-step-${String(projection.version).padStart(6, '0')}`,
      ))
      projection = result.body.data.job
    }
    expect(projection).toMatchObject({
      status: 'complete', totalRecords: 190, processedRecords: 190,
      projectedRecords: 190, version: 191, completedAt: NOW,
    })
    const completedReplay = await continueActivityProjection(input(
      191, 'activity-job-complete-0001',
    ))
    expect(completedReplay).toEqual({
      status: 200, body: { data: { job: projection } },
    })
    await expect(continueActivityProjection(input(
      190, 'activity-job-complete-stale-0001',
    ))).rejects.toMatchObject({
      message: 'VERSION_CONFLICT', details: { currentVersion: 191 },
    })

    expect(await env.DB.prepare(`SELECT
      (SELECT count(*) FROM activity_charges) AS charges,
      (SELECT count(*) FROM activity_classes) AS classes,
      (SELECT count(*) FROM activity_attendance) AS attendance,
      (SELECT count(*) FROM audit_events
       WHERE action='activity.projection.advanced') AS audits`).first()).toEqual({
      charges: 190, classes: 0, attendance: 0, audits: 191,
    })
    const replayRows = (await env.DB.prepare(`SELECT response_envelope
      FROM activity_request_replays
      WHERE operation='activity.projection.continue'`).all()).results
    expect(replayRows).toHaveLength(191)
    expect(replayRows.every(({ response_envelope: envelope }) => (
      !envelope.includes(created.body.data.job.id) && !envelope.includes('Fikcyjna')
    ))).toBe(true)
    const lastAudit = await env.DB.prepare(`SELECT metadata_json,correlation_id
      FROM audit_events WHERE action='activity.projection.advanced'
      ORDER BY rowid DESC LIMIT 1`).first()
    expect(JSON.parse(lastAudit.metadata_json)).toEqual({
      jobVersion: 191, processedCount: 190, projectedCount: 190,
    })
    expect(lastAudit.correlation_id).toBe('activity_materializer_correlation')
    await expect(getActivityProjection({
      db: env.DB,
      actor: { id: 'stf_activity_other_owner', role: 'owner', specialistId: null },
      importId: IMPORT_ID,
    })).rejects.toThrow(/NOT_FOUND/)
    await expect(getActivityProjection({
      db: env.DB, actor: { ...actor, role: 'specialist' }, importId: IMPORT_ID,
    })).rejects.toThrow(/NOT_FOUND/)
  })

  it('backfills rotating lookup aliases and survives old-key retirement without duplicates', async () => {
    await addSource({
      sourceRecordId: 'wbs_activity_rotation_dual',
      financeEntryId: 'fin_activity_rotation_dual',
      sourceKey: 'workbook:v1:2:2:0', rowNumber: 2, recordType: 'tus',
      accountingMonth: '2025-02', occurredOn: null,
      counterparty: 'Ola Fikcyjna', sourceLabel: 'Grupa TUS — Sowy',
      lessonCount: null, amountGrosze: 34000,
    })
    await addSource({
      sourceRecordId: 'wbs_activity_rotation_v2',
      financeEntryId: 'fin_activity_rotation_v2',
      sourceKey: 'workbook:v1:2:3:0', rowNumber: 3, recordType: 'tus',
      accountingMonth: '2025-03', occurredOn: null,
      counterparty: 'Ola Fikcyjna', sourceLabel: 'Grupa TUS — Sowy',
      lessonCount: null, amountGrosze: 34000,
    })
    const configV2 = Object.freeze({ ...config, activeLookupKeyVersion: 2 })
    const dual = await createKeyring({
      BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V1: key(2),
      BWM_LOOKUP_HMAC_V2: key(5), BWM_WORKBOOK_KEK_V1: key(3),
      BWM_WORKBOOK_HMAC_V1: key(4),
    }, configV2)
    const v2Only = await createKeyring({
      BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V2: key(5),
      BWM_WORKBOOK_KEK_V1: key(3), BWM_WORKBOOK_HMAC_V1: key(4),
    }, configV2)
    const common = {
      db: env.DB, recoveryDb: env.DB, config: configV2,
      centreId: 'centre_1', importId: IMPORT_ID,
      actor, nowMs: NOW_MS, idFactory,
    }
    await materializeActivitySlice({
      ...common, keyring: dual, sourceRecordIds: ['wbs_activity_rotation_dual'],
    })
    const dualAliases = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM activity_participant_lookup_aliases AS alias
       JOIN activity_source_links AS link ON link.entity_id=alias.participant_id
       WHERE link.source_record_id='wbs_activity_rotation_dual'
         AND link.relation='participant') AS participant_aliases,
      (SELECT count(*) FROM activity_group_lookup_aliases AS alias
       JOIN activity_source_links AS link ON link.entity_id=alias.group_id
       WHERE link.source_record_id='wbs_activity_rotation_dual'
         AND link.relation='group') AS group_aliases`).first()
    expect(dualAliases).toEqual({ participant_aliases: 2, group_aliases: 2 })
    await materializeActivitySlice({
      ...common, keyring: v2Only, sourceRecordIds: ['wbs_activity_rotation_v2'],
    })
    expect((await env.DB.prepare(`SELECT source_record_id,relation,entity_id
      FROM activity_source_links
      WHERE source_record_id IN ('wbs_activity_rotation_dual','wbs_activity_rotation_v2')
        AND relation IN ('participant','group')
      ORDER BY relation,source_record_id`).all()).results).toEqual([
      {
        source_record_id: 'wbs_activity_rotation_dual', relation: 'group',
        entity_id: expect.stringMatching(/^agr_/),
      },
      {
        source_record_id: 'wbs_activity_rotation_v2', relation: 'group',
        entity_id: expect.stringMatching(/^agr_/),
      },
      {
        source_record_id: 'wbs_activity_rotation_dual', relation: 'participant',
        entity_id: expect.stringMatching(/^acp_/),
      },
      {
        source_record_id: 'wbs_activity_rotation_v2', relation: 'participant',
        entity_id: expect.stringMatching(/^acp_/),
      },
    ])
    const rotationLinks = (await env.DB.prepare(`SELECT relation,entity_id
      FROM activity_source_links
      WHERE source_record_id IN ('wbs_activity_rotation_dual','wbs_activity_rotation_v2')
        AND relation IN ('participant','group')
      ORDER BY relation,source_record_id`).all()).results
    expect(rotationLinks[0].entity_id).toBe(rotationLinks[1].entity_id)
    expect(rotationLinks[2].entity_id).toBe(rotationLinks[3].entity_id)
  })

  it('rejects every authenticated unknown-precision English or TUS source', async () => {
    await addSource({
      sourceRecordId: 'wbs_activity_english_unknown',
      financeEntryId: 'fin_activity_english_unknown',
      sourceKey: 'workbook:v1:3:2:0', rowNumber: 2, recordType: 'english',
      accountingMonth: '2025-04', occurredOn: null,
      counterparty: 'Iga Fikcyjna', sourceLabel: 'Lekcje języka angielskiego',
      lessonCount: 0, amountGrosze: 0,
      periodPrecisionOverride: 'unknown', periodMonthOverride: null,
    })
    await addSource({
      sourceRecordId: 'wbs_activity_tus_unknown',
      financeEntryId: 'fin_activity_tus_unknown',
      sourceKey: 'workbook:v1:3:3:0', rowNumber: 3, recordType: 'tus',
      accountingMonth: '2025-04', occurredOn: null,
      counterparty: 'Iga Fikcyjna', sourceLabel: 'Grupa TUS — Sowy',
      lessonCount: null, amountGrosze: 34000,
      periodPrecisionOverride: 'unknown', periodMonthOverride: null,
    })
    const common = {
      db: env.DB, recoveryDb: env.DB, keyring, config,
      centreId: 'centre_1', importId: IMPORT_ID,
      actor, nowMs: NOW_MS, idFactory,
    }
    for (const sourceRecordId of [
      'wbs_activity_english_unknown', 'wbs_activity_tus_unknown',
    ]) await expect(materializeActivitySlice({
      ...common, sourceRecordIds: [sourceRecordId],
    })).rejects.toThrow(/ACTIVITY_PROJECTION_AUTHORITY_MISMATCH/)
  })

  it('authenticates the complete immutable charge and source-link graph on replay', async () => {
    await addSource({
      sourceRecordId: 'wbs_activity_replay_conflict',
      financeEntryId: 'fin_activity_replay_conflict',
      sourceKey: 'workbook:v1:4:2:0', rowNumber: 2, recordType: 'english',
      accountingMonth: '2025-05', occurredOn: null,
      counterparty: 'Maja Fikcyjna', sourceLabel: 'Lekcje języka angielskiego',
      lessonCount: 0, amountGrosze: 0,
    })
    const participant = await env.DB.prepare(`SELECT link.entity_id
      FROM activity_source_links AS link
      WHERE link.source_record_id='wbs_activity_english_zero'
        AND link.relation='participant'`).first()
    await env.DB.prepare(`INSERT INTO activity_charges
      (id,participant_id,program_id,group_id,membership_id,period_precision,
       occurred_on,accounting_month,lesson_count,responsible_specialist_id,
       finance_entry_id,status,version,created_at,updated_at)
      VALUES ('ach_activity_replay_conflict',?,'apg_english',NULL,NULL,'month',NULL,
       '2025-05',7,'sp_activity_materializer','fin_activity_replay_conflict',
       'active',1,?,?)`).bind(participant.entity_id, NOW, NOW).run()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_source_links
        (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
        VALUES ('asl_activity_replay_participant','wbs_activity_replay_conflict',
         'participant',?,?,?)`).bind(participant.entity_id, actor.id, NOW),
      env.DB.prepare(`INSERT INTO activity_source_links
        (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
        VALUES ('asl_activity_replay_charge','wbs_activity_replay_conflict','charge',
         'ach_activity_replay_conflict',?,?)`).bind(actor.id, NOW),
    ])
    await expect(materializeActivitySlice({
      db: env.DB, recoveryDb: env.DB, keyring, config,
      centreId: 'centre_1', importId: IMPORT_ID,
      actor, nowMs: NOW_MS, idFactory,
      sourceRecordIds: ['wbs_activity_replay_conflict'],
    })).rejects.toThrow(/ACTIVITY_PROJECTION_CONFLICT/)
  })

  it('keeps worst-case creation and authenticated replay inside the ordinary query budget', async () => {
    await addSource({
      sourceRecordId: 'wbs_activity_budget_create',
      financeEntryId: 'fin_activity_budget_create',
      sourceKey: 'workbook:v1:5:2:0', rowNumber: 2, recordType: 'tus',
      accountingMonth: '2025-06', occurredOn: null,
      counterparty: 'Nowa Uczestniczka Fikcyjna',
      sourceLabel: 'Grupa TUS — Nowa Fikcyjna',
      lessonCount: null, amountGrosze: 34000,
    })
    const command = (db, recoveryDb) => ({
      db, recoveryDb, keyring, config, centreId: 'centre_1', importId: IMPORT_ID,
      actor, nowMs: NOW_MS, idFactory,
      sourceRecordIds: ['wbs_activity_budget_create'],
    })
    const createBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    await expect(materializeActivitySlice(command(
      createBudget.work, createBudget.recovery,
    ))).resolves.toMatchObject({
      projectedRecords: 1, replayedRecords: 0,
    })
    const createUsage = usageForD1QueryBudgetViews(
      createBudget.work, createBudget.recovery,
    )
    expect(createUsage).toMatchObject({ totalLimit: 50, recoveryReserve: 8 })
    // A cold activity-key path costs 26; a warmed key costs 25.
    expect(createUsage.used).toBeGreaterThanOrEqual(25)
    expect(createUsage.used).toBeLessThanOrEqual(26)
    expect(createUsage.workRemaining).toBeGreaterThanOrEqual(16)

    const replayBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    await expect(materializeActivitySlice(command(
      replayBudget.work, replayBudget.recovery,
    ))).resolves.toMatchObject({
      projectedRecords: 0, replayedRecords: 1,
    })
    const replayUsage = usageForD1QueryBudgetViews(
      replayBudget.work, replayBudget.recovery,
    )
    expect(replayUsage).toEqual({
      used: 6, remaining: 44, workRemaining: 36,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('fails closed after the bounded 101st participant or group lookup alias', async () => {
    const common = {
      db: env.DB, recoveryDb: env.DB, keyring, config,
      centreId: 'centre_1', importId: IMPORT_ID,
      actor, nowMs: NOW_MS, idFactory,
    }
    await addSource({
      sourceRecordId: 'wbs_activity_alias_cap_participant',
      financeEntryId: 'fin_activity_alias_cap_participant',
      sourceKey: 'workbook:v1:6:2:0', rowNumber: 2, recordType: 'english',
      accountingMonth: '2025-07', occurredOn: null,
      counterparty: 'Maja Fikcyjna', sourceLabel: 'Lekcje języka angielskiego',
      lessonCount: 0, amountGrosze: 0,
    })
    const participant = await env.DB.prepare(`SELECT entity_id FROM activity_source_links
      WHERE source_record_id='wbs_activity_english_zero' AND relation='participant'`).first()
    const participantAliasCount = (await env.DB.prepare(`SELECT count(*) AS count
      FROM activity_participant_lookup_aliases WHERE participant_id=?`)
      .bind(participant.entity_id).first()).count
    await env.DB.batch(Array.from({ length: 101 - participantAliasCount }, (_, index) => (
      env.DB.prepare(`INSERT INTO activity_participant_lookup_aliases
        (participant_id,program_id,domain,hmac_version,lookup_digest,created_at)
        VALUES (?,'apg_english','bwm:activity-participant:v1',99,?,?)`).bind(
        participant.entity_id, `P${String(index).padStart(42, '0')}`, NOW,
      )
    )))
    await expect(materializeActivitySlice({
      ...common, sourceRecordIds: ['wbs_activity_alias_cap_participant'],
    })).rejects.toThrow(/ACTIVITY_PROJECTION_INVALID/)

    await addSource({
      sourceRecordId: 'wbs_activity_alias_cap_group_seed',
      financeEntryId: 'fin_activity_alias_cap_group_seed',
      sourceKey: 'workbook:v1:6:3:0', rowNumber: 3, recordType: 'tus',
      accountingMonth: '2025-07', occurredOn: null,
      counterparty: 'Nowa Limitowana Uczestniczka Fikcyjna',
      sourceLabel: 'Grupa TUS — Limitowana Fikcyjna',
      lessonCount: null, amountGrosze: 34000,
    })
    await materializeActivitySlice({
      ...common, sourceRecordIds: ['wbs_activity_alias_cap_group_seed'],
    })
    const group = await env.DB.prepare(`SELECT entity_id FROM activity_source_links
      WHERE source_record_id='wbs_activity_alias_cap_group_seed' AND relation='group'`).first()
    const groupAliasCount = (await env.DB.prepare(`SELECT count(*) AS count
      FROM activity_group_lookup_aliases WHERE group_id=?`).bind(group.entity_id).first()).count
    await env.DB.batch(Array.from({ length: 101 - groupAliasCount }, (_, index) => (
      env.DB.prepare(`INSERT INTO activity_group_lookup_aliases
        (group_id,program_id,domain,hmac_version,lookup_digest,created_at)
        VALUES (?,'apg_tus','bwm:activity-group:v1',99,?,?)`).bind(
        group.entity_id, `G${String(index).padStart(42, '0')}`, NOW,
      )
    )))
    await addSource({
      sourceRecordId: 'wbs_activity_alias_cap_group_replay',
      financeEntryId: 'fin_activity_alias_cap_group_replay',
      sourceKey: 'workbook:v1:6:4:0', rowNumber: 4, recordType: 'tus',
      accountingMonth: '2025-08', occurredOn: null,
      counterparty: 'Nowa Limitowana Uczestniczka Fikcyjna',
      sourceLabel: 'Grupa TUS — Limitowana Fikcyjna',
      lessonCount: null, amountGrosze: 34000,
    })
    await expect(materializeActivitySlice({
      ...common, sourceRecordIds: ['wbs_activity_alias_cap_group_replay'],
    })).rejects.toThrow(/ACTIVITY_PROJECTION_INVALID/)
  })
})
