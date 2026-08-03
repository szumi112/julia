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
])

const STAGES = Object.freeze({
  'stage-a': CORE_MIGRATION_STAGE_A_NAMES,
  'stage-b': CORE_MIGRATION_STAGE_B_NAMES,
})
const KNOWN_NAMES = Object.freeze([
  ...CORE_MIGRATION_STAGE_A_NAMES,
  ...CORE_MIGRATION_STAGE_B_NAMES,
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
