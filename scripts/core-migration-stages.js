export const CORE_MIGRATION_STAGE_A_NAMES = Object.freeze([
  '0001_security_primitives.sql',
  '0002_identity_operations.sql',
  '0003_rate_limit_guard.sql',
  '0004_staff_provisioning_state.sql',
  '0005_outbox_operation_guard.sql',
  '0006_delivery_attempt_uniqueness.sql',
  '0007_operational_health_indexes.sql',
  '0008_outbox_drain_heartbeat.sql',
  '0009_core_directory_expand.sql',
])

export const CORE_MIGRATION_STAGE_B_NAMES = Object.freeze([
  '0010_specialist_lifecycle_assertion.sql',
  '0011_appointment_ledger.sql',
])

export const CORE_MIGRATION_STAGE_C_NAMES = Object.freeze([
  '0012_finance_ledger.sql',
  '0013_finance_source_deduplication.sql',
  '0014_finance_import_recovery.sql',
])

export const CORE_MIGRATION_STAGE_D_NAMES = Object.freeze([
  '0015_unclaimed_specialist_profiles.sql',
])

export const CORE_MIGRATION_STAGE_E_NAMES = Object.freeze([
  '0016_workbook_source_records.sql',
  '0017_historical_workspace.sql',
  '0018_activity_workspace.sql',
  '0019_dual_role_specialists.sql',
  '0020_capability_overrides.sql',
])

export const CORE_MIGRATION_REMOTE_ENV_NAMES = Object.freeze(['production', 'staging'])

export const CORE_MIGRATION_PRODUCTION_ACK_VARIABLE = 'BWM_CONFIRM_PRODUCTION_DATABASE'

export const CORE_DIRECTORY_INVARIANT_FAILURE_SQL = `SELECT failure_kind
FROM (
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM staff_users AS staff
      WHERE staff.role='specialist' AND staff.specialist_id IS NULL
    ) THEN 'missing_profile'
    WHEN EXISTS (
      SELECT 1 FROM specialists AS specialist
      WHERE NOT EXISTS (
        SELECT 1 FROM staff_users AS staff
        WHERE staff.id=specialist.staff_user_id
          AND staff.specialist_id IS NOT NULL
      )
    ) THEN 'orphan_profile'
    WHEN EXISTS (
      SELECT 1 FROM specialists AS specialist
      JOIN staff_users AS staff ON staff.id=specialist.staff_user_id
      WHERE staff.specialist_id IS NOT specialist.id
    ) THEN 'pointer_mismatch'
    WHEN EXISTS (
      SELECT 1 FROM staff_users AS staff
      WHERE staff.specialist_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM specialists AS specialist
        WHERE specialist.id=staff.specialist_id
          AND specialist.staff_user_id=staff.id
      )
    ) THEN 'missing_profile'
    WHEN EXISTS (
      SELECT 1 FROM specialists AS specialist
      JOIN staff_users AS staff
        ON staff.id=specialist.staff_user_id
       AND staff.specialist_id=specialist.id
      WHERE specialist.status IS NOT CASE staff.status
        WHEN 'pending' THEN 'pending'
        WHEN 'active' THEN 'active'
        WHEN 'disabled' THEN 'archived'
      END
    ) THEN 'status_mismatch'
    WHEN EXISTS (
      SELECT 1 FROM specialists AS specialist
      WHERE NOT EXISTS (
        SELECT 1 FROM record_versions AS version
        WHERE version.entity_type='specialist'
          AND version.entity_id=specialist.id
          AND version.version=specialist.version
      )
    ) THEN 'missing_version'
    WHEN EXISTS (
      SELECT 1 FROM specialists AS specialist
      WHERE (
        SELECT count(*) FROM record_versions AS version
        WHERE version.entity_type='specialist'
          AND version.entity_id=specialist.id
      )!=specialist.version
         OR (
           SELECT min(version.version) FROM record_versions AS version
           WHERE version.entity_type='specialist'
             AND version.entity_id=specialist.id
         ) IS NOT 1
         OR (
           SELECT max(version.version) FROM record_versions AS version
           WHERE version.entity_type='specialist'
             AND version.entity_id=specialist.id
         ) IS NOT specialist.version
    ) THEN 'noncontiguous_versions'
    WHEN NOT EXISTS (
      SELECT 1 FROM system_state AS state
      WHERE state.key='core_directory_specialist_backfill_v1'
        AND json_valid(state.value_json)
        AND json_type(state.value_json)='object'
        AND (SELECT count(*) FROM json_each(state.value_json))=4
        AND (SELECT count(*) FROM json_each(state.value_json)
             WHERE key IN ('afterStaffId','createdCount','processedCount','status'))=4
        AND json_type(state.value_json,'$.createdCount')='integer'
        AND json_extract(state.value_json,'$.createdCount')>=0
        AND json_type(state.value_json,'$.processedCount')='integer'
        AND json_extract(state.value_json,'$.processedCount')>=0
        AND json_extract(state.value_json,'$.createdCount')
          <=json_extract(state.value_json,'$.processedCount')
        AND json_type(state.value_json,'$.status')='text'
        AND json_extract(state.value_json,'$.status')='complete'
        AND (
          (json_type(state.value_json,'$.afterStaffId')='null'
            AND json_extract(state.value_json,'$.processedCount')=0)
          OR
          (json_type(state.value_json,'$.afterStaffId')='text'
            AND length(CAST(json_extract(state.value_json,'$.afterStaffId') AS BLOB))
              =length(json_extract(state.value_json,'$.afterStaffId'))
            AND length(json_extract(state.value_json,'$.afterStaffId')) BETWEEN 5 AND 128
            AND substr(json_extract(state.value_json,'$.afterStaffId'),1,4)='stf_'
            AND substr(json_extract(state.value_json,'$.afterStaffId'),5,1) GLOB '[A-Za-z0-9]'
            AND substr(json_extract(state.value_json,'$.afterStaffId'),5)
              NOT GLOB '*[^A-Za-z0-9_-]*'
            AND json_extract(state.value_json,'$.processedCount')>=1)
        )
        AND state.value_json='{"afterStaffId":'
          || CASE json_type(state.value_json,'$.afterStaffId')
            WHEN 'null' THEN 'null'
            ELSE json_quote(json_extract(state.value_json,'$.afterStaffId'))
          END
          || ',"createdCount":' || json_extract(state.value_json,'$.createdCount')
          || ',"processedCount":' || json_extract(state.value_json,'$.processedCount')
          || ',"status":"complete"}'
        AND typeof(state.version)='integer'
        AND state.version=json_extract(state.value_json,'$.processedCount')+2
    ) THEN 'upgrade_incomplete'
    ELSE NULL
  END AS failure_kind
)
WHERE failure_kind IS NOT NULL`

const STAGES = Object.freeze({
  'stage-a': CORE_MIGRATION_STAGE_A_NAMES,
  'stage-b': CORE_MIGRATION_STAGE_B_NAMES,
  'stage-c': CORE_MIGRATION_STAGE_C_NAMES,
  'stage-d': CORE_MIGRATION_STAGE_D_NAMES,
  'stage-e': CORE_MIGRATION_STAGE_E_NAMES,
})
const KNOWN_NAMES = Object.freeze([
  ...CORE_MIGRATION_STAGE_A_NAMES,
  ...CORE_MIGRATION_STAGE_B_NAMES,
  ...CORE_MIGRATION_STAGE_C_NAMES,
  ...CORE_MIGRATION_STAGE_D_NAMES,
  ...CORE_MIGRATION_STAGE_E_NAMES,
])

const invalid = () => {
  throw new Error('CORE_MIGRATION_STAGE_INVALID')
}

export function selectCoreMigrationStage(migrations, stage) {
  const allowlist = STAGES[stage]
  if (!allowlist || !Array.isArray(migrations)) invalid()
  const byName = new Map()
  let previousIndex = -1
  for (const migration of migrations) {
    if (!migration
      || typeof migration !== 'object'
      || Array.isArray(migration)
      || Object.keys(migration).length !== 2
      || !Object.hasOwn(migration, 'name')
      || !Object.hasOwn(migration, 'queries')
      || typeof migration.name !== 'string'
      || !Array.isArray(migration.queries)
      || migration.queries.some((query) => typeof query !== 'string')) invalid()
    const knownIndex = KNOWN_NAMES.indexOf(migration.name)
    if (knownIndex < 0 || knownIndex <= previousIndex || byName.has(migration.name)) invalid()
    previousIndex = knownIndex
    byName.set(migration.name, migration)
  }
  const selected = allowlist.map((name) => byName.get(name))
  if (selected.some((migration) => !migration)) invalid()
  return Object.freeze(selected)
}

export function selectCoreMigrationRemoteTarget(config, envName) {
  if (!CORE_MIGRATION_REMOTE_ENV_NAMES.includes(envName)
    || !config
    || typeof config !== 'object'
    || Array.isArray(config)) invalid()
  const block = config.env?.[envName]
  if (block === undefined) throw new Error('CORE_MIGRATION_REMOTE_ENV_MISSING')
  const databases = block?.d1_databases
  if (!block
    || typeof block !== 'object'
    || Array.isArray(block)
    || !Array.isArray(databases)
    || databases.length !== 1
    || databases[0]?.binding !== 'DB'
    || typeof databases[0].database_name !== 'string'
    || databases[0].database_name === '') {
    throw new Error('CORE_MIGRATION_REMOTE_ENV_INVALID')
  }
  return Object.freeze({ databaseName: databases[0].database_name, envName })
}

export function confirmCoreMigrationRemoteTarget(env, target) {
  if (!env
    || typeof env !== 'object'
    || Array.isArray(env)
    || !target
    || typeof target !== 'object'
    || Array.isArray(target)
    || !CORE_MIGRATION_REMOTE_ENV_NAMES.includes(target.envName)
    || typeof target.databaseName !== 'string'
    || target.databaseName === '') invalid()
  if (target.envName === 'production'
    && env[CORE_MIGRATION_PRODUCTION_ACK_VARIABLE] !== target.databaseName) {
    throw new Error('CORE_MIGRATION_REMOTE_PRODUCTION_UNCONFIRMED')
  }
  return target
}
