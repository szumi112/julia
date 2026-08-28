const INVALID = 'BACKUP_RECOVERY_INVALID'
const APPROVED_WORKBOOK_SHA256 = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const MIGRATION_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/
const POLLUTING_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ID_PATTERNS = Object.freeze({
  artifact: /^wba_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  import: /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  finance: /^wbj_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  historical: /^hpj_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  activity: /^apj_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
})

const migration = (id, name) => Object.freeze({ id, name })

export const CORE_PRE_WORKBOOK_MIGRATIONS = Object.freeze([
  migration(1, '0001_security_primitives.sql'),
  migration(2, '0002_identity_operations.sql'),
  migration(3, '0003_rate_limit_guard.sql'),
  migration(4, '0004_staff_provisioning_state.sql'),
  migration(5, '0005_outbox_operation_guard.sql'),
  migration(6, '0006_delivery_attempt_uniqueness.sql'),
  migration(7, '0007_operational_health_indexes.sql'),
  migration(8, '0008_outbox_drain_heartbeat.sql'),
  migration(9, '0009_core_directory_expand.sql'),
  migration(10, '0010_specialist_lifecycle_assertion.sql'),
  migration(11, '0011_appointment_ledger.sql'),
  migration(12, '0012_finance_ledger.sql'),
  migration(13, '0013_finance_source_deduplication.sql'),
  migration(14, '0014_finance_import_recovery.sql'),
  migration(15, '0015_unclaimed_specialist_profiles.sql'),
])

export const WORKBOOK_ROUNDTRIP_MIGRATIONS = Object.freeze([
  ...CORE_PRE_WORKBOOK_MIGRATIONS,
  migration(16, '0016_workbook_source_records.sql'),
  migration(17, '0017_historical_workspace.sql'),
  migration(18, '0018_activity_workspace.sql'),
  migration(19, '0019_dual_role_specialists.sql'),
  migration(20, '0020_capability_overrides.sql'),
  migration(21, '0021_finance_reporting_registry.sql'),
])

const ARTIFACT_KEYS = Object.freeze([
  'id', 'fingerprint', 'byteSize', 'parserVersion', 'materializerVersion',
])
const IMPORT_KEYS = Object.freeze([
  'id', 'status', 'version', 'acceptedRecords', 'quarantinedRecords',
])
const FINANCE_KEYS = Object.freeze([
  'jobId', 'status', 'phase', 'version', 'cursor', 'totalRecords',
  'processedRecords', 'reportingRevision',
])
const HISTORICAL_KEYS = Object.freeze([
  'jobId', 'status', 'version', 'totalRecords', 'processedRecords',
  'projectedRecords', 'conflictCount', 'resolutionCount', 'occurrenceCount',
  'explicitExclusionCount', 'automaticDeferredCount', 'unresolvedCount',
])
const ACTIVITY_KEYS = Object.freeze([
  'jobId', 'status', 'version', 'totalRecords', 'processedRecords',
  'projectedRecords', 'participantLinkCount', 'chargeLinkCount',
  'groupLinkCount', 'membershipObservationLinkCount', 'physicalLinkCount',
])
const RECONCILIATION_KEYS = Object.freeze([
  'activeAcceptedSourceRecords', 'quarantinedSourceRecords',
  'monthlyDateQuarantines', 'fixedOrphanAmountQuarantines',
  'amountStoredAsTextWarnings', 'correctedCombinedSheetMonths', 'tusRecords',
  'englishRecords', 'formulaGhostsExcluded', 'unexplainedDroppedCandidates',
  'replayCreatedRecords', 'replayVoidedRecords', 'ledgerLinksUnique',
  'projectionLinksUnique', 'parentTotalsReconcile', 'crossProjectionOverlapCount',
])
const WORKBOOK_KEYS = Object.freeze([
  'kind', 'artifact', 'import', 'finance', 'historical', 'activity',
  'reconciliation',
])

const WORKBOOK_ROW_KEYS = Object.freeze([
  'applied_migrations_json', 'artifact_id', 'fingerprint', 'byte_size', 'parser_version',
  'materializer_version', 'import_id', 'import_status', 'import_version',
  'import_terminal_bad_count',
  'accepted_records', 'quarantined_records', 'finance_job_id', 'finance_status',
  'finance_phase', 'finance_version', 'finance_cursor', 'finance_total_records',
  'finance_processed_records', 'finance_reporting_revision',
  'finance_terminal_bad_count', 'historical_job_id',
  'historical_status', 'historical_version', 'historical_total_records',
  'historical_processed_records', 'historical_projected_records',
  'historical_conflict_count', 'historical_conflict_row_count',
  'historical_resolution_count',
  'historical_occurrence_count', 'historical_explicit_exclusion_count',
  'historical_automatic_deferred_count', 'historical_unresolved_count',
  'historical_terminal_bad_count', 'historical_partition_bad_count',
  'historical_cursor_bad_count', 'historical_accepted_income_source_count',
  'historical_eligible_source_count',
  'activity_job_id', 'activity_status',
  'activity_version', 'activity_total_records', 'activity_processed_records',
  'activity_projected_records', 'activity_participant_link_count',
  'activity_charge_link_count', 'activity_group_link_count',
  'activity_membership_observation_link_count', 'activity_physical_link_count',
  'activity_terminal_bad_count', 'activity_graph_bad_count',
  'activity_cursor_bad_count', 'activity_candidate_source_count',
  'active_accepted_source_records',
  'quarantined_source_records', 'monthly_date_quarantines',
  'fixed_orphan_amount_quarantines', 'amount_stored_as_text_warnings',
  'corrected_combined_sheet_months', 'tus_records', 'english_records',
  'formula_ghosts_excluded', 'candidate_count', 'matched_candidate_count',
  'unexplained_candidate_count',
  'replay_created_records', 'replay_voided_records',
  'accepted_finance_link_count', 'missing_accepted_finance_link_count',
  'quarantined_finance_link_count', 'voided_accepted_finance_link_count',
  'source_record_count', 'cross_projection_overlap_count',
])

const fail = () => { throw new Error(INVALID) }
const count = (value) => Number.isSafeInteger(value) && value >= 0
const positive = (value) => Number.isSafeInteger(value) && value > 0
const id = (value, pattern) => typeof value === 'string' && pattern.test(value)

function capturedObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail()
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || ownKeys.some((key) => (
    typeof key !== 'string' || POLLUTING_KEYS.has(key) || !keys.includes(key)
  ))) fail()
  const captured = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')) fail()
    captured[key] = descriptor.value
  }
  return captured
}

function capturedProperty(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || descriptor.enumerable !== true
    || !Object.hasOwn(descriptor, 'value')) fail()
  return descriptor.value
}

function capturedArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail()
  const ownKeys = Reflect.ownKeys(value)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || Object.hasOwn(lengthDescriptor, 'get')
    || Object.hasOwn(lengthDescriptor, 'set')
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || ownKeys.length !== lengthDescriptor.value + 1) fail()
  const captured = []
  for (const key of ownKeys) {
    if (key === 'length') continue
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) fail()
    const index = Number(key)
    if (!Number.isSafeInteger(index) || String(index) !== key
      || index >= lengthDescriptor.value) fail()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')) fail()
    captured[index] = descriptor.value
  }
  if (captured.length !== lengthDescriptor.value
    || captured.some((_, index) => !Object.hasOwn(captured, index))) fail()
  return captured
}

function migrationRows(value) {
  const values = capturedArray(value)
  if (values.length < 1 || values.length > 256) fail()
  const rows = []
  const names = new Set()
  let previous = 0
  for (const valueRow of values) {
    const row = capturedObject(valueRow, ['id', 'name'])
    if (!positive(row.id) || row.id <= previous || typeof row.name !== 'string'
      || !MIGRATION_NAME.test(row.name) || names.has(row.name)
      || new TextEncoder().encode(row.name).byteLength > 255) fail()
    previous = row.id
    names.add(row.name)
    rows.push(row)
  }
  return rows
}

function sameMigrations(left, right) {
  return left.length === right.length && left.every((row, index) => (
    row.id === right[index].id && row.name === right[index].name
  ))
}

function validateCore(value) {
  const facts = capturedObject(value, ['kind'])
  if (facts.kind !== 'core_pre_workbook_v1') fail()
  return facts
}

function validateWorkbook(value) {
  const facts = capturedObject(value, WORKBOOK_KEYS)
  if (facts.kind !== 'workbook_roundtrip_v1') fail()
  const artifact = capturedObject(facts.artifact, ARTIFACT_KEYS)
  const imported = capturedObject(facts.import, IMPORT_KEYS)
  const finance = capturedObject(facts.finance, FINANCE_KEYS)
  const historical = capturedObject(facts.historical, HISTORICAL_KEYS)
  const activity = capturedObject(facts.activity, ACTIVITY_KEYS)
  const reconciliation = capturedObject(facts.reconciliation, RECONCILIATION_KEYS)

  if (!id(artifact.id, ID_PATTERNS.artifact)
    || artifact.fingerprint !== APPROVED_WORKBOOK_SHA256
    || !positive(artifact.byteSize) || artifact.byteSize > 5 * 1024 * 1024
    || artifact.parserVersion !== 2 || artifact.materializerVersion !== 2
    || !id(imported.id, ID_PATTERNS.import) || imported.status !== 'complete'
    || !positive(imported.version) || imported.acceptedRecords !== 2_232
    || imported.quarantinedRecords !== 3
    || !id(finance.jobId, ID_PATTERNS.finance) || finance.status !== 'complete'
    || finance.phase !== 'complete' || !positive(finance.version)
    || !positive(finance.totalRecords) || finance.cursor !== finance.totalRecords
    || finance.processedRecords !== finance.totalRecords
    || finance.totalRecords !== imported.acceptedRecords
    || !positive(finance.reportingRevision)
    || !id(historical.jobId, ID_PATTERNS.historical)
    || historical.status !== 'complete' || !positive(historical.version)
    || historical.totalRecords !== 2_000 || historical.processedRecords !== 2_000
    || historical.projectedRecords !== 1_997
    || historical.conflictCount !== 1_992
    || historical.resolutionCount !== 1_992
    || historical.occurrenceCount !== 1_997
    || historical.explicitExclusionCount !== 0
    || historical.automaticDeferredCount !== 3
    || historical.unresolvedCount !== 0
    || historical.occurrenceCount + historical.explicitExclusionCount
      + historical.automaticDeferredCount !== historical.totalRecords
    || !id(activity.jobId, ID_PATTERNS.activity)
    || activity.status !== 'complete' || !positive(activity.version)
    || activity.totalRecords !== 190 || activity.processedRecords !== 190
    || activity.projectedRecords !== 190 || activity.participantLinkCount !== 190
    || activity.chargeLinkCount !== 190 || activity.groupLinkCount !== 25
    || activity.membershipObservationLinkCount !== 25
    || activity.physicalLinkCount !== 430) fail()

  const expectedCounts = {
    activeAcceptedSourceRecords: 2_232,
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
    crossProjectionOverlapCount: 0,
  }
  if (Object.entries(expectedCounts).some(([key, expected]) => (
    reconciliation[key] !== expected
  )) || reconciliation.ledgerLinksUnique !== true
    || reconciliation.projectionLinksUnique !== true
    || reconciliation.parentTotalsReconcile !== true) fail()
  return {
    kind: facts.kind,
    artifact,
    import: imported,
    finance,
    historical,
    activity,
    reconciliation,
  }
}

function validateRecoveryFacts(value) {
  const kind = capturedProperty(value, 'kind')
  if (kind === 'core_pre_workbook_v1') return validateCore(value)
  if (kind === 'workbook_roundtrip_v1') return validateWorkbook(value)
  fail()
}

export function validateBackupRecoveryFacts(value) {
  try { return validateRecoveryFacts(value) } catch { fail() }
}

export function recoveryFactsMatchMigrations(recoveryFacts, appliedMigrations) {
  try {
    const facts = validateRecoveryFacts(recoveryFacts)
    const migrations = migrationRows(appliedMigrations)
    if (facts.kind === 'core_pre_workbook_v1') {
      if (!sameMigrations(migrations, CORE_PRE_WORKBOOK_MIGRATIONS)) fail()
    } else if (!sameMigrations(migrations, WORKBOOK_ROUNDTRIP_MIGRATIONS)) fail()
    return true
  } catch { fail() }
}

const MIGRATIONS_SQL = `SELECT id,name
FROM d1_migrations
ORDER BY id
LIMIT 257`

const WORKBOOK_SQL = `WITH migration_snapshot AS (
  SELECT json_group_array(json_object('id',ordered.id,'name',ordered.name))
    AS applied_migrations_json
  FROM (SELECT id,name FROM d1_migrations ORDER BY id LIMIT 257) AS ordered
)
SELECT
  migration_snapshot.applied_migrations_json AS applied_migrations_json,
  artifact.id AS artifact_id,
  artifact.fingerprint AS fingerprint,
  artifact.byte_size AS byte_size,
  artifact.parser_version AS parser_version,
  artifact.materializer_version AS materializer_version,
  imported.id AS import_id,
  imported.status AS import_status,
  imported.version AS import_version,
  CASE WHEN imported.status='complete' AND imported.completed_at IS NOT NULL
    THEN 0 ELSE 1 END AS import_terminal_bad_count,
  imported.accepted_records AS accepted_records,
  imported.quarantined_records AS quarantined_records,
  finance_job.id AS finance_job_id,
  finance_job.status AS finance_status,
  finance_job.phase AS finance_phase,
  finance_job.version AS finance_version,
  finance_job.cursor AS finance_cursor,
  finance_job.total_records AS finance_total_records,
  finance_job.processed_records AS finance_processed_records,
  reporting.revision AS finance_reporting_revision,
  CASE WHEN finance_job.status='complete' AND finance_job.phase='complete'
      AND finance_job.completed_at IS NOT NULL AND finance_job.summary_json IS NOT NULL
      AND finance_job.cursor=finance_job.total_records
      AND finance_job.processed_records=finance_job.total_records
    THEN 0 ELSE 1 END AS finance_terminal_bad_count,
  historical_job.id AS historical_job_id,
  historical_job.status AS historical_status,
  historical_job.version AS historical_version,
  historical_job.total_records AS historical_total_records,
  historical_job.processed_records AS historical_processed_records,
  historical_job.projected_records AS historical_projected_records,
  historical_job.conflict_count AS historical_conflict_count,
  (SELECT count(*) FROM historical_projection_conflicts AS conflict
   WHERE conflict.job_id=historical_job.id) AS historical_conflict_row_count,
  (SELECT count(*) FROM historical_conflict_resolutions AS resolution
   JOIN historical_projection_conflicts AS conflict ON conflict.id=resolution.conflict_id
   WHERE conflict.job_id=historical_job.id) AS historical_resolution_count,
  (SELECT count(*) FROM historical_service_occurrences AS occurrence
   JOIN workbook_source_records AS source ON source.id=occurrence.source_record_id
   WHERE source.import_id=imported.id AND occurrence.status='recorded')
    AS historical_occurrence_count,
  (SELECT count(DISTINCT conflict.source_record_id)
   FROM historical_projection_conflicts AS conflict
   JOIN historical_conflict_resolutions AS resolution ON resolution.conflict_id=conflict.id
   WHERE conflict.job_id=historical_job.id AND resolution.classification='exclude')
    AS historical_explicit_exclusion_count,
  (SELECT count(*) FROM workbook_source_records AS source
   JOIN workbook_finance_decisions AS decision
     ON decision.import_id=source.import_id AND decision.source_record_id=source.id
      AND decision.action='insert'
   WHERE source.import_id=imported.id AND source.disposition='accepted'
     AND source.record_type='income' AND source.sheet_name='Stałe koszty'
     AND source.period_precision='month')
    AS historical_automatic_deferred_count,
  (SELECT count(*) FROM historical_projection_conflicts AS conflict
   WHERE conflict.job_id=historical_job.id AND NOT EXISTS (
     SELECT 1 FROM historical_conflict_resolutions AS resolution
     WHERE resolution.conflict_id=conflict.id)) AS historical_unresolved_count,
  CASE WHEN historical_job.status='complete'
      AND historical_job.completed_at IS NOT NULL
      AND historical_job.processed_records=historical_job.total_records
    THEN 0 ELSE 1 END AS historical_terminal_bad_count,
  (SELECT count(*) FROM workbook_source_records AS source
   JOIN finance_source_links AS finance_link ON finance_link.source_record_id=source.id
   JOIN finance_entries AS entry ON entry.id=finance_link.finance_entry_id
   WHERE source.import_id=imported.id AND source.disposition='accepted'
     AND source.record_type='income' AND entry.kind='income'
     AND entry.specialist_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM finance_entry_voids AS void
       WHERE void.finance_entry_id=entry.id)
     AND ((SELECT count(*) FROM historical_service_occurrences AS occurrence
           WHERE occurrence.source_record_id=source.id AND occurrence.status='recorded')
       + (SELECT CASE WHEN EXISTS (
           SELECT 1 FROM historical_projection_conflicts AS conflict
           JOIN historical_conflict_resolutions AS resolution
             ON resolution.conflict_id=conflict.id
           WHERE conflict.job_id=historical_job.id
             AND conflict.source_record_id=source.id
             AND resolution.classification='exclude') THEN 1 ELSE 0 END)
       + CASE WHEN source.sheet_name='Stałe koszty'
           AND source.period_precision='month' AND EXISTS (
           SELECT 1 FROM workbook_finance_decisions AS decision
           WHERE decision.import_id=source.import_id
             AND decision.source_record_id=source.id AND decision.action='insert')
         THEN 1 ELSE 0 END)<>1) AS historical_partition_bad_count,
  CASE WHEN historical_job.after_source_record_id IS (
    SELECT max(source.id) FROM workbook_source_records AS source
    JOIN finance_source_links AS finance_link ON finance_link.source_record_id=source.id
    JOIN finance_entries AS entry ON entry.id=finance_link.finance_entry_id
    LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
    WHERE source.import_id=imported.id AND source.disposition='accepted'
      AND source.record_type='income' AND entry.kind='income'
      AND entry.specialist_id IS NOT NULL AND void.id IS NULL)
    THEN 0 ELSE 1 END AS historical_cursor_bad_count,
  (SELECT count(*) FROM workbook_source_records AS source
   WHERE source.import_id=imported.id AND source.disposition='accepted'
     AND source.record_type='income') AS historical_accepted_income_source_count,
  (SELECT count(*) FROM workbook_source_records AS source
   JOIN finance_source_links AS finance_link ON finance_link.source_record_id=source.id
   JOIN finance_entries AS entry ON entry.id=finance_link.finance_entry_id
   LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
   WHERE source.import_id=imported.id AND source.disposition='accepted'
     AND source.record_type='income' AND entry.kind='income'
     AND entry.specialist_id IS NOT NULL AND void.id IS NULL)
    AS historical_eligible_source_count,
  activity_job.id AS activity_job_id,
  activity_job.status AS activity_status,
  activity_job.version AS activity_version,
  activity_job.total_records AS activity_total_records,
  activity_job.processed_records AS activity_processed_records,
  activity_job.projected_records AS activity_projected_records,
  (SELECT count(*) FROM activity_source_links AS link
   JOIN workbook_source_records AS source ON source.id=link.source_record_id
   WHERE source.import_id=imported.id AND link.relation='participant')
    AS activity_participant_link_count,
  (SELECT count(*) FROM activity_source_links AS link
   JOIN workbook_source_records AS source ON source.id=link.source_record_id
   WHERE source.import_id=imported.id AND link.relation='charge')
    AS activity_charge_link_count,
  (SELECT count(*) FROM activity_source_links AS link
   JOIN workbook_source_records AS source ON source.id=link.source_record_id
   WHERE source.import_id=imported.id AND link.relation='group')
    AS activity_group_link_count,
  (SELECT count(*) FROM activity_source_links AS link
   JOIN workbook_source_records AS source ON source.id=link.source_record_id
   WHERE source.import_id=imported.id AND link.relation='membership_observation')
    AS activity_membership_observation_link_count,
  (SELECT count(*) FROM activity_source_links AS link
   JOIN workbook_source_records AS source ON source.id=link.source_record_id
   WHERE source.import_id=imported.id) AS activity_physical_link_count,
  CASE WHEN activity_job.status='complete' AND activity_job.completed_at IS NOT NULL
      AND activity_job.processed_records=activity_job.total_records
      AND activity_job.projected_records=activity_job.total_records
    THEN 0 ELSE 1 END AS activity_terminal_bad_count,
  (SELECT count(*) FROM workbook_source_records AS source
   WHERE source.import_id=imported.id AND source.disposition='accepted'
     AND source.record_type IN ('english','tus') AND (
       (SELECT count(*) FROM activity_source_links AS link
        WHERE link.source_record_id=source.id AND link.relation='participant')<>1
       OR (SELECT count(*) FROM activity_source_links AS link
        WHERE link.source_record_id=source.id AND link.relation='charge')<>1
       OR (SELECT count(*) FROM activity_source_links AS link
        WHERE link.source_record_id=source.id AND link.relation='group')
          <>CASE WHEN source.record_type='tus' THEN 1 ELSE 0 END
       OR (SELECT count(*) FROM activity_source_links AS link
        WHERE link.source_record_id=source.id AND link.relation='membership_observation')
          <>CASE WHEN source.record_type='tus' THEN 1 ELSE 0 END
       OR NOT EXISTS (
         SELECT 1 FROM activity_source_links AS charge_link
         JOIN activity_charges AS charge ON charge.id=charge_link.entity_id
           AND charge.status='active'
         JOIN activity_programs AS program ON program.id=charge.program_id
           AND program.code=source.record_type
         JOIN activity_source_links AS participant_link
           ON participant_link.source_record_id=source.id
          AND participant_link.relation='participant'
          AND participant_link.entity_id=charge.participant_id
         JOIN finance_source_links AS finance_link
           ON finance_link.source_record_id=source.id
          AND finance_link.finance_entry_id=charge.finance_entry_id
         WHERE charge_link.source_record_id=source.id AND charge_link.relation='charge'
           AND ((source.record_type='english'
                 AND charge.group_id IS NULL AND charge.membership_id IS NULL)
             OR (source.record_type='tus' AND EXISTS (
               SELECT 1 FROM activity_source_links AS group_link
               WHERE group_link.source_record_id=source.id AND group_link.relation='group'
                 AND group_link.entity_id=charge.group_id)
               AND EXISTS (
                 SELECT 1 FROM activity_source_links AS membership_link
                 JOIN activity_memberships AS membership
                   ON membership.id=membership_link.entity_id
                 WHERE membership_link.source_record_id=source.id
                   AND membership_link.relation='membership_observation'
                   AND membership.id=charge.membership_id
                   AND membership.participant_id=charge.participant_id
                   AND membership.group_id=charge.group_id
                   AND membership.program_id=charge.program_id
                   AND membership.membership_kind='observation')))))
    AS activity_graph_bad_count,
  CASE WHEN activity_job.after_source_record_id IS (
    SELECT max(source.id) FROM workbook_source_records AS source
    WHERE source.import_id=imported.id AND source.disposition='accepted'
      AND source.record_type IN ('tus','english'))
    THEN 0 ELSE 1 END AS activity_cursor_bad_count,
  (SELECT count(*) FROM workbook_source_records AS source
   WHERE source.import_id=imported.id AND source.disposition='accepted'
     AND source.record_type IN ('tus','english')) AS activity_candidate_source_count,
  (SELECT count(*) FROM workbook_source_records AS source
   WHERE source.import_id=imported.id AND source.disposition='accepted')
    AS active_accepted_source_records,
  (SELECT count(*) FROM workbook_source_records AS source
   WHERE source.import_id=imported.id AND source.disposition='quarantined')
    AS quarantined_source_records,
  (SELECT count(*) FROM workbook_quarantine_records AS quarantine
   JOIN workbook_source_records AS source ON source.id=quarantine.source_record_id
   WHERE source.import_id=imported.id
     AND quarantine.primary_reason IN ('SERVICE_DATE_MISSING','SERVICE_DATE_INVALID'))
    AS monthly_date_quarantines,
  (SELECT count(*) FROM workbook_quarantine_records AS quarantine
   JOIN workbook_source_records AS source ON source.id=quarantine.source_record_id
   WHERE source.import_id=imported.id AND quarantine.primary_reason='ORPHAN_AMOUNT')
    AS fixed_orphan_amount_quarantines,
  (SELECT count(*) FROM workbook_source_records AS source,json_each(source.warning_codes_json) AS warning
   WHERE source.import_id=imported.id AND warning.value='AMOUNT_STORED_AS_TEXT')
    AS amount_stored_as_text_warnings,
  (SELECT count(*) FROM workbook_finance_decisions AS decision
   WHERE decision.import_id=imported.id AND decision.accounting_month_changed=1)
    AS corrected_combined_sheet_months,
  (SELECT count(*) FROM workbook_source_records AS source
   WHERE source.import_id=imported.id AND source.record_type='tus') AS tus_records,
  (SELECT count(*) FROM workbook_source_records AS source
   WHERE source.import_id=imported.id AND source.record_type='english') AS english_records,
  (SELECT count(*) FROM workbook_finance_decisions AS decision
   WHERE decision.import_id=imported.id AND decision.reason_code='formula_cache')
    AS formula_ghosts_excluded,
  (SELECT count(*) FROM workbook_finance_candidates AS candidate
   WHERE candidate.import_id=imported.id) AS candidate_count,
  (SELECT count(*) FROM workbook_finance_candidates AS candidate
   WHERE candidate.import_id=imported.id AND EXISTS (
     SELECT 1 FROM workbook_finance_decisions AS decision
     WHERE decision.import_id=candidate.import_id
       AND decision.finance_entry_id=candidate.finance_entry_id)) AS matched_candidate_count,
  (SELECT count(*) FROM workbook_finance_candidates AS candidate
   WHERE candidate.import_id=imported.id AND NOT EXISTS (
     SELECT 1 FROM workbook_finance_decisions AS decision
     WHERE decision.import_id=candidate.import_id
       AND decision.finance_entry_id=candidate.finance_entry_id))
    AS unexplained_candidate_count,
  (SELECT count(*)-count(DISTINCT decision.source_record_id)
   FROM workbook_finance_decisions AS decision
   WHERE decision.import_id=imported.id AND decision.action='insert')
    AS replay_created_records,
  (SELECT count(*)-count(DISTINCT decision.finance_entry_id)
   FROM workbook_finance_decisions AS decision
   WHERE decision.import_id=imported.id AND decision.action='void')
    AS replay_voided_records,
  (SELECT count(*) FROM finance_source_links AS link
   JOIN workbook_source_records AS source ON source.id=link.source_record_id
   WHERE source.import_id=imported.id AND source.disposition='accepted')
    AS accepted_finance_link_count,
  (SELECT count(*) FROM workbook_source_records AS source
   WHERE source.import_id=imported.id AND source.disposition='accepted'
     AND NOT EXISTS (SELECT 1 FROM finance_source_links AS link
       WHERE link.source_record_id=source.id)) AS missing_accepted_finance_link_count,
  (SELECT count(*) FROM finance_source_links AS link
   JOIN workbook_source_records AS source ON source.id=link.source_record_id
   WHERE source.import_id=imported.id AND source.disposition='quarantined')
    AS quarantined_finance_link_count,
  (SELECT count(*) FROM finance_source_links AS link
   JOIN workbook_source_records AS source ON source.id=link.source_record_id
   WHERE source.import_id=imported.id AND source.disposition='accepted' AND (
     EXISTS (SELECT 1 FROM finance_entry_voids AS void
       WHERE void.finance_entry_id=link.finance_entry_id)
     OR EXISTS (SELECT 1 FROM finance_manual_voids AS void
       WHERE void.finance_entry_id=link.finance_entry_id)))
    AS voided_accepted_finance_link_count,
  (SELECT count(*) FROM workbook_source_records AS source
   WHERE source.import_id=imported.id) AS source_record_count,
  (SELECT count(*) FROM workbook_source_records AS source
   WHERE source.import_id=imported.id
     AND EXISTS (SELECT 1 FROM historical_service_occurrences AS occurrence
       WHERE occurrence.source_record_id=source.id AND occurrence.status='recorded')
     AND EXISTS (SELECT 1 FROM activity_source_links AS link
       WHERE link.source_record_id=source.id AND link.relation='charge'))
    AS cross_projection_overlap_count
FROM migration_snapshot
JOIN workbook_imports AS imported
JOIN workbook_artifacts AS artifact ON artifact.id=imported.artifact_id
JOIN workbook_import_plans AS plan ON plan.import_id=imported.id
  AND plan.workbook_kind='legacy'
JOIN workbook_materialization_jobs AS finance_job ON finance_job.import_id=imported.id
JOIN historical_projection_jobs AS historical_job ON historical_job.import_id=imported.id
JOIN activity_projection_jobs AS activity_job ON activity_job.import_id=imported.id
JOIN finance_reporting_state AS reporting ON reporting.authority_key='finance'
WHERE artifact.fingerprint='${APPROVED_WORKBOOK_SHA256}'
  AND artifact.centre_id='centre_1' AND artifact.environment='staging'
ORDER BY imported.id
LIMIT 2`

function factsFromRow(value) {
  const row = capturedObject(value, WORKBOOK_ROW_KEYS)
  if (WORKBOOK_ROW_KEYS.filter((key) => key.endsWith('_count')
      || key.endsWith('_records') || key.endsWith('_version')
      || key.endsWith('_revision') || key.endsWith('_cursor')
      || key === 'byte_size')
    .some((key) => !count(row[key]))) fail()
  const unexplained = row.unexplained_candidate_count
  if (row.candidate_count !== row.matched_candidate_count + unexplained) fail()
  if (row.import_terminal_bad_count !== 0 || row.finance_terminal_bad_count !== 0
    || row.historical_terminal_bad_count !== 0
    || row.historical_conflict_row_count !== row.historical_conflict_count
    || row.historical_cursor_bad_count !== 0
    || row.historical_accepted_income_source_count !== row.historical_total_records
    || row.historical_eligible_source_count !== row.historical_total_records
    || row.activity_terminal_bad_count !== 0 || row.activity_cursor_bad_count !== 0
    || row.activity_candidate_source_count !== row.activity_total_records) fail()
  const ledgerLinksUnique = row.accepted_finance_link_count === 2_232
    && row.missing_accepted_finance_link_count === 0
    && row.quarantined_finance_link_count === 0
    && row.voided_accepted_finance_link_count === 0
  const projectionLinksUnique = row.historical_partition_bad_count === 0
    && row.activity_graph_bad_count === 0
    && row.cross_projection_overlap_count === 0
  const parentTotalsReconcile = row.source_record_count
    === row.accepted_records + row.quarantined_records
  return validateBackupRecoveryFacts({
    kind: 'workbook_roundtrip_v1',
    artifact: {
      id: row.artifact_id,
      fingerprint: row.fingerprint,
      byteSize: row.byte_size,
      parserVersion: row.parser_version,
      materializerVersion: row.materializer_version,
    },
    import: {
      id: row.import_id,
      status: row.import_status,
      version: row.import_version,
      acceptedRecords: row.accepted_records,
      quarantinedRecords: row.quarantined_records,
    },
    finance: {
      jobId: row.finance_job_id,
      status: row.finance_status,
      phase: row.finance_phase,
      version: row.finance_version,
      cursor: row.finance_cursor,
      totalRecords: row.finance_total_records,
      processedRecords: row.finance_processed_records,
      reportingRevision: row.finance_reporting_revision,
    },
    historical: {
      jobId: row.historical_job_id,
      status: row.historical_status,
      version: row.historical_version,
      totalRecords: row.historical_total_records,
      processedRecords: row.historical_processed_records,
      projectedRecords: row.historical_projected_records,
      conflictCount: row.historical_conflict_count,
      resolutionCount: row.historical_resolution_count,
      occurrenceCount: row.historical_occurrence_count,
      explicitExclusionCount: row.historical_explicit_exclusion_count,
      automaticDeferredCount: row.historical_automatic_deferred_count,
      unresolvedCount: row.historical_unresolved_count,
    },
    activity: {
      jobId: row.activity_job_id,
      status: row.activity_status,
      version: row.activity_version,
      totalRecords: row.activity_total_records,
      processedRecords: row.activity_processed_records,
      projectedRecords: row.activity_projected_records,
      participantLinkCount: row.activity_participant_link_count,
      chargeLinkCount: row.activity_charge_link_count,
      groupLinkCount: row.activity_group_link_count,
      membershipObservationLinkCount: row.activity_membership_observation_link_count,
      physicalLinkCount: row.activity_physical_link_count,
    },
    reconciliation: {
      activeAcceptedSourceRecords: row.active_accepted_source_records,
      quarantinedSourceRecords: row.quarantined_source_records,
      monthlyDateQuarantines: row.monthly_date_quarantines,
      fixedOrphanAmountQuarantines: row.fixed_orphan_amount_quarantines,
      amountStoredAsTextWarnings: row.amount_stored_as_text_warnings,
      correctedCombinedSheetMonths: row.corrected_combined_sheet_months,
      tusRecords: row.tus_records,
      englishRecords: row.english_records,
      formulaGhostsExcluded: row.formula_ghosts_excluded,
      unexplainedDroppedCandidates: unexplained,
      replayCreatedRecords: row.replay_created_records,
      replayVoidedRecords: row.replay_voided_records,
      ledgerLinksUnique,
      projectionLinksUnique,
      parentTotalsReconcile,
      crossProjectionOverlapCount: row.cross_projection_overlap_count,
    },
  })
}

function rowsValue(rows) {
  return capturedArray(rows)
}

async function readSnapshotWithQuery(query) {
  if (typeof query !== 'function') fail()
  let compound
  let compoundThrew = false
  try { compound = await query(WORKBOOK_SQL) } catch { compoundThrew = true }
  if (!compoundThrew) {
    const rows = rowsValue(compound)
    if (rows.length !== 1) fail()
    const raw = capturedObject(rows[0], WORKBOOK_ROW_KEYS)
    let parsed
    try { parsed = JSON.parse(raw.applied_migrations_json) } catch { fail() }
    const migrations = migrationRows(parsed)
    if (JSON.stringify(migrations) !== raw.applied_migrations_json
      || !sameMigrations(migrations, WORKBOOK_ROUNDTRIP_MIGRATIONS)) fail()
    const recoveryFacts = factsFromRow(raw)
    recoveryFactsMatchMigrations(recoveryFacts, migrations)
    return { appliedMigrations: migrations, recoveryFacts }
  }
  let fallback
  try { fallback = await query(MIGRATIONS_SQL) } catch { fail() }
  const migrations = migrationRows(rowsValue(fallback))
  if (!sameMigrations(migrations, CORE_PRE_WORKBOOK_MIGRATIONS)) fail()
  const recoveryFacts = validateBackupRecoveryFacts({ kind: 'core_pre_workbook_v1' })
  recoveryFactsMatchMigrations(recoveryFacts, migrations)
  return { appliedMigrations: migrations, recoveryFacts }
}

export async function readBackupRecoverySnapshotWithQuery(query) {
  try { return await readSnapshotWithQuery(query) } catch { fail() }
}

export async function readBackupRecoverySnapshot(db) {
  try {
    if (!db || typeof db.prepare !== 'function') fail()
    return await readSnapshotWithQuery(async (sql) => {
      let response
      try { response = await db.prepare(sql).all() } catch { fail() }
      try {
        const results = capturedProperty(response, 'results')
        return Array.isArray(results) ? results : null
      } catch { return null }
    })
  } catch { fail() }
}
