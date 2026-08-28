import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CORE_PRE_WORKBOOK_MIGRATIONS,
  WORKBOOK_ROUNDTRIP_MIGRATIONS,
  readBackupRecoverySnapshotWithQuery,
  readBackupRecoverySnapshot,
  validateBackupRecoveryFacts,
} from '../../worker/operations/backup-recovery.js'

const approvedFingerprint = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'

const workbookRow = (overrides = {}) => ({
  applied_migrations_json: JSON.stringify(WORKBOOK_ROUNDTRIP_MIGRATIONS),
  artifact_id: 'wba_recovery_fixture',
  fingerprint: approvedFingerprint,
  byte_size: 456789,
  parser_version: 2,
  materializer_version: 2,
  import_id: 'wbi_recovery_fixture',
  import_status: 'complete',
  import_version: 12,
  import_terminal_bad_count: 0,
  accepted_records: 2232,
  quarantined_records: 3,
  finance_job_id: 'wbj_recovery_fixture',
  finance_status: 'complete',
  finance_phase: 'complete',
  finance_version: 19,
  finance_cursor: 2232,
  finance_total_records: 2232,
  finance_processed_records: 2232,
  finance_reporting_revision: 44,
  finance_terminal_bad_count: 0,
  historical_job_id: 'hpj_recovery_fixture',
  historical_status: 'complete',
  historical_version: 2040,
  historical_total_records: 2000,
  historical_processed_records: 2000,
  historical_projected_records: 1997,
  historical_conflict_count: 1992,
  historical_resolution_count: 1992,
  historical_occurrence_count: 1997,
  historical_explicit_exclusion_count: 0,
  historical_automatic_deferred_count: 3,
  historical_unresolved_count: 0,
  historical_conflict_row_count: 1992,
  historical_terminal_bad_count: 0,
  historical_partition_bad_count: 0,
  historical_cursor_bad_count: 0,
  historical_accepted_income_source_count: 2000,
  historical_eligible_source_count: 2000,
  activity_job_id: 'apj_recovery_fixture',
  activity_status: 'complete',
  activity_version: 192,
  activity_total_records: 190,
  activity_processed_records: 190,
  activity_projected_records: 190,
  activity_participant_link_count: 190,
  activity_charge_link_count: 190,
  activity_group_link_count: 25,
  activity_membership_observation_link_count: 25,
  activity_physical_link_count: 430,
  activity_terminal_bad_count: 0,
  activity_graph_bad_count: 0,
  activity_cursor_bad_count: 0,
  activity_candidate_source_count: 190,
  active_accepted_source_records: 2232,
  quarantined_source_records: 3,
  monthly_date_quarantines: 2,
  fixed_orphan_amount_quarantines: 1,
  amount_stored_as_text_warnings: 2,
  corrected_combined_sheet_months: 45,
  tus_records: 25,
  english_records: 165,
  formula_ghosts_excluded: 5,
  candidate_count: 2234,
  matched_candidate_count: 2234,
  unexplained_candidate_count: 0,
  replay_created_records: 0,
  replay_voided_records: 0,
  accepted_finance_link_count: 2232,
  missing_accepted_finance_link_count: 0,
  quarantined_finance_link_count: 0,
  voided_accepted_finance_link_count: 0,
  source_record_count: 2235,
  cross_projection_overlap_count: 0,
  ...overrides,
})

const workbookFacts = () => ({
  kind: 'workbook_roundtrip_v1',
  artifact: {
    id: 'wba_recovery_fixture',
    fingerprint: approvedFingerprint,
    byteSize: 456789,
    parserVersion: 2,
    materializerVersion: 2,
  },
  import: {
    id: 'wbi_recovery_fixture', status: 'complete', version: 12,
    acceptedRecords: 2232, quarantinedRecords: 3,
  },
  finance: {
    jobId: 'wbj_recovery_fixture', status: 'complete', phase: 'complete',
    version: 19, cursor: 2232, totalRecords: 2232, processedRecords: 2232,
    reportingRevision: 44,
  },
  historical: {
    jobId: 'hpj_recovery_fixture', status: 'complete', version: 2040,
    totalRecords: 2000, processedRecords: 2000, projectedRecords: 1997,
    conflictCount: 1992, resolutionCount: 1992, occurrenceCount: 1997,
    explicitExclusionCount: 0, automaticDeferredCount: 3, unresolvedCount: 0,
  },
  activity: {
    jobId: 'apj_recovery_fixture', status: 'complete', version: 192,
    totalRecords: 190, processedRecords: 190, projectedRecords: 190,
    participantLinkCount: 190, chargeLinkCount: 190, groupLinkCount: 25,
    membershipObservationLinkCount: 25, physicalLinkCount: 430,
  },
  reconciliation: {
    activeAcceptedSourceRecords: 2232,
    quarantinedSourceRecords: 3,
    monthlyDateQuarantines: 2,
    fixedOrphanAmountQuarantines: 1,
    amountStoredAsTextWarnings: 2,
    correctedCombinedSheetMonths: 45,
    tusRecords: 25,
    englishRecords: 165,
    formulaGhostsExcluded: 5,
    unexplainedDroppedCandidates: 0,
    replayCreatedRecords: 0,
    replayVoidedRecords: 0,
    ledgerLinksUnique: true,
    projectionLinksUnique: true,
    parentTotalsReconcile: true,
    crossProjectionOverlapCount: 0,
  },
})

test('classifies only the literal 0001-0015 vector as core pre-workbook recovery', async () => {
  const calls = []
  const result = await readBackupRecoverySnapshotWithQuery(async (sql) => {
    calls.push(sql)
    if (calls.length === 1) throw new Error('no such table: workbook_imports')
    return structuredClone(CORE_PRE_WORKBOOK_MIGRATIONS)
  })
  assert.deepEqual(result, {
    appliedMigrations: CORE_PRE_WORKBOOK_MIGRATIONS,
    recoveryFacts: { kind: 'core_pre_workbook_v1' },
  })
  assert.equal(calls.length, 2)

  for (const migrations of [
    CORE_PRE_WORKBOOK_MIGRATIONS.slice(0, -1),
    [...CORE_PRE_WORKBOOK_MIGRATIONS, WORKBOOK_ROUNDTRIP_MIGRATIONS[15]],
    CORE_PRE_WORKBOOK_MIGRATIONS.map((row, index) => index === 4 ? { ...row, name: '0005_wrong.sql' } : row),
  ]) {
    await assert.rejects(
      readBackupRecoverySnapshotWithQuery(async (_sql) => {
        if (_sql.includes('workbook_imports')) throw new Error('no such table')
        return structuredClone(migrations)
      }),
      /BACKUP_RECOVERY_INVALID/,
    )
  }
})

test('reads the exact terminal workbook snapshot and preserves only count-only facts', async () => {
  let calls = 0
  const result = await readBackupRecoverySnapshotWithQuery(async (sql) => {
    calls += 1
    assert.match(sql, /workbook_imports/)
    assert.match(sql, /artifact\.centre_id='centre_1'/)
    assert.match(sql, /artifact\.environment='staging'/)
    assert.match(sql, /source\.period_precision='month'/)
    return [workbookRow()]
  })
  assert.deepEqual(result, {
    appliedMigrations: WORKBOOK_ROUNDTRIP_MIGRATIONS,
    recoveryFacts: workbookFacts(),
  })
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(result).includes('sheet_name'), false)
})

test('workbook recovery fails closed for absent, ambiguous, incomplete and inconsistent state', async () => {
  const variants = [
    [],
    [workbookRow(), workbookRow({ import_id: 'wbi_other' })],
    [workbookRow({ finance_status: 'running' })],
    [workbookRow({ import_terminal_bad_count: 1 })],
    [workbookRow({ finance_terminal_bad_count: 1 })],
    [workbookRow({ historical_terminal_bad_count: 1 })],
    [workbookRow({ historical_conflict_row_count: 1991 })],
    [workbookRow({ historical_unresolved_count: 1 })],
    [workbookRow({ historical_partition_bad_count: 1 })],
    [workbookRow({ historical_cursor_bad_count: 1 })],
    [workbookRow({ historical_accepted_income_source_count: 1999 })],
    [workbookRow({ historical_eligible_source_count: 1999 })],
    [workbookRow({ activity_charge_link_count: 189, activity_physical_link_count: 429 })],
    [workbookRow({ activity_graph_bad_count: 1 })],
    [workbookRow({ activity_terminal_bad_count: 1 })],
    [workbookRow({ activity_cursor_bad_count: 1 })],
    [workbookRow({ activity_candidate_source_count: 189 })],
    [workbookRow({ missing_accepted_finance_link_count: 1 })],
    [workbookRow({ quarantined_finance_link_count: 1 })],
    [workbookRow({ matched_candidate_count: 2233, unexplained_candidate_count: 1 })],
    [workbookRow({ matched_candidate_count: 2233 })],
    [workbookRow({ cross_projection_overlap_count: 1 })],
    [workbookRow({ fingerprint: 'a'.repeat(64) })],
  ]
  for (const rows of variants) {
    let calls = 0
    await assert.rejects(readBackupRecoverySnapshotWithQuery(async (sql) => {
      calls += 1
      assert.match(sql, /workbook_imports/)
      return rows
    }), /BACKUP_RECOVERY_INVALID/)
    assert.equal(calls, 1)
  }
})

test('compound snapshot failure never disguises a partial workbook schema as core', async () => {
  for (const migrations of [
    WORKBOOK_ROUNDTRIP_MIGRATIONS.slice(0, 16),
    WORKBOOK_ROUNDTRIP_MIGRATIONS.slice(0, 20),
    WORKBOOK_ROUNDTRIP_MIGRATIONS,
  ]) {
    let calls = 0
    await assert.rejects(readBackupRecoverySnapshotWithQuery(async () => {
      calls += 1
      if (calls === 1) throw new Error('compound failed')
      return structuredClone(migrations)
    }), /BACKUP_RECOVERY_INVALID/)
    assert.equal(calls, 2)
  }
})

test('a successful malformed D1 compound response never falls back to migrations', async () => {
  for (const response of [
    { results: [] },
    { wrong: [] },
    Object.defineProperty({}, 'results', {
      enumerable: true,
      get() { throw new Error('RESULTS_GETTER_MARKER') },
    }),
  ]) {
    let calls = 0
    const db = {
      prepare() {
        calls += 1
        return { async all() { return response } }
      },
    }
    await assert.rejects(
      readBackupRecoverySnapshot(db),
      (error) => error?.message === 'BACKUP_RECOVERY_INVALID',
    )
    assert.equal(calls, 1)
  }
})

test('recovery-fact validation is exact-keyed and enforces all terminal equations', () => {
  assert.deepEqual(validateBackupRecoveryFacts(workbookFacts()), workbookFacts())
  assert.deepEqual(validateBackupRecoveryFacts({ kind: 'core_pre_workbook_v1' }), {
    kind: 'core_pre_workbook_v1',
  })
  for (const mutate of [
    (value) => { value.extra = true },
    (value) => { value.artifact.extra = true },
    (value) => { value.import.acceptedRecords = 2231 },
    (value) => { value.finance.cursor -= 1 },
    (value) => { value.historical.projectedRecords -= 1 },
    (value) => { value.historical.automaticDeferredCount = 2 },
    (value) => { value.activity.projectedRecords = 189 },
    (value) => { value.activity.physicalLinkCount = 429 },
    (value) => { value.reconciliation.ledgerLinksUnique = false },
    (value) => { value.reconciliation.replayCreatedRecords = 1 },
    (value) => { value.artifact.byteSize = 5 * 1024 * 1024 + 1 },
  ]) {
    const value = workbookFacts()
    mutate(value)
    assert.throws(() => validateBackupRecoveryFacts(value), /BACKUP_RECOVERY_INVALID/)
  }
  const boundary = workbookFacts()
  boundary.artifact.byteSize = 5 * 1024 * 1024
  assert.deepEqual(validateBackupRecoveryFacts(boundary), boundary)
})

test('recovery facts pin the approved historical projection partition', () => {
  const shiftedPartition = workbookFacts()
  shiftedPartition.historical.projectedRecords = 1996
  shiftedPartition.historical.occurrenceCount = 1996
  shiftedPartition.historical.explicitExclusionCount = 1
  assert.throws(
    () => validateBackupRecoveryFacts(shiftedPartition),
    /BACKUP_RECOVERY_INVALID/,
  )

  const shiftedConflicts = workbookFacts()
  shiftedConflicts.historical.conflictCount = 1991
  shiftedConflicts.historical.resolutionCount = 1991
  assert.throws(
    () => validateBackupRecoveryFacts(shiftedConflicts),
    /BACKUP_RECOVERY_INVALID/,
  )
})

test('recovery boundaries reject hostile descriptors without invoking getters or leaking traps', async () => {
  let invoked = false
  const accessor = workbookFacts()
  Object.defineProperty(accessor.artifact, 'fingerprint', {
    enumerable: true,
    get() { invoked = true; throw new Error('GETTER_MARKER') },
  })
  const nonEnumerable = workbookFacts()
  Object.defineProperty(nonEnumerable.activity, 'physicalLinkCount', {
    enumerable: false,
    value: 430,
  })
  const withSymbol = workbookFacts()
  withSymbol.import[Symbol('hidden')] = true
  const polluted = workbookFacts()
  Object.defineProperty(polluted.finance, '__proto__', { enumerable: true, value: null })
  const wrongPrototype = workbookFacts()
  wrongPrototype.reconciliation = Object.assign(Object.create({ inherited: true }),
    wrongPrototype.reconciliation)
  const trapped = new Proxy(workbookFacts(), {
    ownKeys() { throw new Error('PROXY_MARKER') },
  })
  for (const value of [accessor, nonEnumerable, withSymbol, polluted, wrongPrototype, trapped]) {
    assert.throws(
      () => validateBackupRecoveryFacts(value),
      (error) => error?.message === 'BACKUP_RECOVERY_INVALID',
    )
  }
  assert.equal(invoked, false)

  const hostileRow = workbookRow()
  Object.defineProperty(hostileRow, 'fingerprint', {
    enumerable: true,
    get() { invoked = true; throw new Error('ROW_GETTER_MARKER') },
  })
  await assert.rejects(
    readBackupRecoverySnapshotWithQuery(async () => [hostileRow]),
    (error) => error?.message === 'BACKUP_RECOVERY_INVALID',
  )
  assert.equal(invoked, false)
})

test('recovery query arrays are dense descriptor-safe values', async () => {
  let invoked = false
  const accessorRows = [workbookRow()]
  Object.defineProperty(accessorRows, '0', {
    configurable: true,
    enumerable: true,
    get() { invoked = true; throw new Error('ARRAY_GETTER_MARKER') },
  })
  const nonEnumerableRows = [workbookRow()]
  Object.defineProperty(nonEnumerableRows, '0', {
    configurable: true,
    enumerable: false,
    value: workbookRow(),
  })
  const symbolicRows = [workbookRow()]
  symbolicRows[Symbol('hidden')] = true
  const trappedRows = new Proxy([workbookRow()], {
    getOwnPropertyDescriptor() { throw new Error('ARRAY_PROXY_MARKER') },
  })
  for (const rows of [accessorRows, nonEnumerableRows, symbolicRows, trappedRows]) {
    await assert.rejects(
      readBackupRecoverySnapshotWithQuery(async () => rows),
      (error) => error?.message === 'BACKUP_RECOVERY_INVALID',
    )
  }
  assert.equal(invoked, false)

  const migrationAccessor = structuredClone(CORE_PRE_WORKBOOK_MIGRATIONS)
  Object.defineProperty(migrationAccessor, '0', {
    configurable: true,
    enumerable: true,
    get() { invoked = true; throw new Error('MIGRATION_ARRAY_GETTER_MARKER') },
  })
  await assert.rejects(readBackupRecoverySnapshotWithQuery(async (sql) => {
    if (sql.includes('workbook_imports')) throw new Error('no table')
    return migrationAccessor
  }), (error) => error?.message === 'BACKUP_RECOVERY_INVALID')
  assert.equal(invoked, false)
})
