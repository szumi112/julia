import {
  CORE_MIGRATION_STAGE_A_NAMES,
  CORE_MIGRATION_STAGE_B_NAMES,
  CORE_MIGRATION_STAGE_C_NAMES,
  CORE_MIGRATION_STAGE_D_NAMES,
  CORE_MIGRATION_STAGE_E_NAMES,
} from './core-migration-stages.js'

const KNOWN_MIGRATIONS = Object.freeze([
  ...CORE_MIGRATION_STAGE_A_NAMES,
  ...CORE_MIGRATION_STAGE_B_NAMES,
  ...CORE_MIGRATION_STAGE_C_NAMES,
  ...CORE_MIGRATION_STAGE_D_NAMES,
  ...CORE_MIGRATION_STAGE_E_NAMES,
])

const failed = () => { throw new Error('MIGRATION_STATUS_STAGING_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const exactRow = (value) => plain(value)
  && Reflect.ownKeys(value).length === 2
  && Object.hasOwn(value, 'id')
  && Object.hasOwn(value, 'name')

export async function migrationStatusEvidence(rows) {
  try {
    if (!Array.isArray(rows) || rows.length !== KNOWN_MIGRATIONS.length) failed()
    const migrationNames = []
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!exactRow(row) || row.id !== index + 1 || row.name !== KNOWN_MIGRATIONS[index]) failed()
      migrationNames.push(row.name)
    }
    const names = Object.freeze(migrationNames)
    const bytes = new TextEncoder().encode(JSON.stringify(names))
    let digest
    try {
      digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const migrationSetSha256 = [...digest]
        .map((value) => value.toString(16).padStart(2, '0')).join('')
      return Object.freeze({
        migrationNames: names,
        migrationCount: names.length,
        migrationSetSha256,
        status: 'ok',
      })
    } finally {
      bytes.fill(0)
      digest?.fill(0)
    }
  } catch {
    throw new Error('MIGRATION_STATUS_STAGING_FAILED')
  }
}
